// Web Bluetooth client for Whoop 4.0.
//
// On connect:
//   1. open GATT + subscribe to RESPONSE / DATA / EVENT chars
//   2. GET_HELLO_HARVARD → learn charging + wrist-worn + serial
//   3. SET_CLOCK if the strap's RTC drifted (or RTC_LOST fires later)
//   4. SEND_HISTORICAL_DATA → drain the strap's flash buffer (backfill)
//   5. TOGGLE_REALTIME_HR(0x01) → start the realtime sample stream
//
// On HIGH_FREQ_SYNC_PROMPT event (strap flash filling up), kick off another
// historical dump.
//
// Auto-reconnects with exponential backoff on `gattserverdisconnected`.

import { FAMILIES } from './uuids.js';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber, MetadataType,
  EVENT_TYPES, METADATA_TYPES, buildCommandFrame, buildV5CommandFrame, decodeV5,
} from './packet.js';
import {
  decodePacket, parseBatteryResponse, parseClockResponse,
  parseHelloResponse, parseHistorical, parseRealtimeRaw,
} from './parsers.js';
import { createEmitter } from '../util/events.js';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const BATTERY_POLL_MS = 60000;
const RTC_DRIFT_THRESHOLD_S = 5;
const META_QUEUE_TIMEOUT_MS = 120000;

// WHOOP 5.0 connect preamble. The strap ignores all commands until this
// CLIENT_HELLO (cmd 0x91 = GET_HELLO, capabilities byte 0x01) is written to the
// command characteristic. Identical to buildV5CommandFrame(1, 0x91, [0x01]);
// kept as a literal so a framing regression can't silently break the handshake.
const CLIENT_HELLO_V5 = new Uint8Array([
  0xaa, 0x01, 0x08, 0x00, 0x00, 0x01, 0xe6, 0x71,
  0x23, 0x01, 0x91, 0x01, 0x36, 0x3e, 0x5c, 0x8d,
]);

/**
 * Tiny async queue used to feed METADATA packets from the data-channel
 * notification handler into the historical-dump coroutine.
 */
class AsyncQueue {
  constructor() { this._items = []; this._waiters = []; }
  push(x) {
    if (this._waiters.length) {
      const [resolve] = this._waiters.shift();
      resolve(x);
    } else {
      this._items.push(x);
    }
  }
  async pop(timeoutMs) {
    if (this._items.length) return this._items.shift();
    return new Promise((resolve, reject) => {
      const entry = [resolve, reject];
      this._waiters.push(entry);
      if (timeoutMs) {
        setTimeout(() => {
          const i = this._waiters.indexOf(entry);
          if (i >= 0) { this._waiters.splice(i, 1); reject(new Error('queue timeout')); }
        }, timeoutMs);
      }
    });
  }
  clear() { this._items.length = 0; }

  // Reject every pending pop() waiter so a coroutine blocked on the queue
  // (e.g. the historical-dump loop) unwinds immediately instead of waiting out
  // its 30s timeout. Used on disconnect.
  drain(err) {
    this._items.length = 0;
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      const reject = w[1];
      if (reject) reject(err);
    }
  }
}

export class WhoopClient {
  constructor() {
    this._emitter = createEmitter();
    this.device = null;
    this.server = null;
    this.charCmd = null;
    this.charResp = null;
    this.charData = null;
    this.charEvent = null;
    this.charDiag = null;
    this.connected = false;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._intentionalDisconnect = false;
    this._seq = 0;
    this._batteryPollInterval = null;
    this._metaQueue = new AsyncQueue();
    this._historicalDumpInFlight = false;
    this._disconnectHandler = null;
    this._state = 'disconnected';
    this._family = 'whoop4';   // resolved per-connection from the discovered service
    this._physiologyGapMs = 250;  // inter-command spacing for the 5.0 capture sequence

    // Cached strap state surfaced to the UI:
    this.charging = null;
    this.isWorn = null;
    this.serial = null;
    this.batteryPct = null;
    this.lastClockUnix = null;
  }

  // ----- event emitter ----------------------------------------------------

  on(event, fn) { return this._emitter.on(event, fn); }
  _emit(event, payload) { this._emitter.emit(event, payload); }
  _setState(s) { this._state = s; this._emit('state', s); }

  // ----- connection lifecycle ---------------------------------------------

  async requestAndConnect() {
    this._intentionalDisconnect = false;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [FAMILIES.whoop5.service] },
        { services: [FAMILIES.whoop4.service] },
        { namePrefix: 'WHOOP' },
      ],
      optionalServices: [FAMILIES.whoop5.service, FAMILIES.whoop4.service],
    });
    this._attachDisconnectHandler();
    await this._connect();
  }

  async connectToDevice(device) {
    this._intentionalDisconnect = false;
    // If the cached device.gatt still thinks it's connected from a prior
    // session, disconnect it first so gatt.connect() can start fresh.
    if (device.gatt && device.gatt.connected) {
      try { device.gatt.disconnect(); } catch {}
    }
    this.server = null;
    this.device = device;
    this._attachDisconnectHandler();
    await this._connect();
  }

  // Attach the gattserverdisconnected handler exactly once per device, removing
  // any previous one first, so repeated connect calls on the same (possibly
  // bridge-cached) device object don't stack handlers and fire N parallel
  // reconnect chains + battery pollers.
  _attachDisconnectHandler() {
    if (this._disconnectHandler) {
      this.device.removeEventListener('gattserverdisconnected', this._disconnectHandler);
    }
    this._disconnectHandler = () => this._onDisconnected();
    this.device.addEventListener('gattserverdisconnected', this._disconnectHandler);
  }

  async _connect() {
    this._setState('connecting');
    this.server = await this.device.gatt.connect();

    // Detect the strap generation: probe the 5.0 service first, fall back to
    // 4.0 only when that service is genuinely absent (NotFoundError). Any other
    // failure (mid-connection GATT error, power event) must propagate, not be
    // mistaken for "this is a 4.0 strap" — that would send 4.0 frames to a 5.0
    // device and silently break the session.
    let service;
    try {
      service = await this.server.getPrimaryService(FAMILIES.whoop5.service);
      this._family = 'whoop5';
    } catch (err) {
      if (err && err.name && err.name !== 'NotFoundError') throw err;
      service = await this.server.getPrimaryService(FAMILIES.whoop4.service);
      this._family = 'whoop4';
    }
    const f = FAMILIES[this._family];
    this._emit('family', { family: this._family, name: f.name });

    this.charCmd   = await service.getCharacteristic(f.command);
    this.charResp  = await service.getCharacteristic(f.response);
    this.charData  = await service.getCharacteristic(f.data);
    this.charEvent = await service.getCharacteristic(f.event);
    // Diagnostic characteristic (slot 0007) — optional. Used only to elicit 5.0
    // skin-temp candidate packets; its absence must never abort the connection.
    try { this.charDiag = await service.getCharacteristic(f.diag); }
    catch { this.charDiag = null; }

    this.charData.addEventListener('characteristicvaluechanged', (e) => this._onData(e));
    await this.charData.startNotifications();

    this.charResp.addEventListener('characteristicvaluechanged', (e) => this._onResponse(e));
    await this.charResp.startNotifications();

    this.charEvent.addEventListener('characteristicvaluechanged', (e) => this._onEvent(e));
    await this.charEvent.startNotifications();

    // 5.0 straps ignore every command until this CLIENT_HELLO lands, so a failed
    // write means a dead session — let it propagate so _connect rejects and the
    // reconnect backoff retries, rather than limping on with a strap that
    // silently drops all subsequent commands.
    if (this._family === 'whoop5') {
      await this.charCmd.writeValue(CLIENT_HELLO_V5);
      this._clientHelloSent = true;
    }

    this.connected = true;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._setState('connected');

    // Kick off the post-connect flow without blocking the caller.
    this._postConnectFlow().catch((err) => this._emit('error', err));

    // Battery poller
    this._batteryPollInterval = setInterval(() => this.getBatteryLevel(), BATTERY_POLL_MS);
  }

  async _postConnectFlow() {
    // 1. Strap identity / status
    try { await this.sendHello(); } catch (e) { this._emit('error', e); }

    // 2. Time sync — Web BLE doesn't always surface RTC_LOST quickly enough,
    //    so we proactively check current strap clock and set if drifted.
    try {
      const strapUnix = await this.getClock();
      const hostUnix = Math.floor(Date.now() / 1000);
      if (strapUnix && Math.abs(hostUnix - strapUnix) > RTC_DRIFT_THRESHOLD_S) {
        await this.setClock();
      }
    } catch (e) { this._emit('error', e); }

    // 2b. Disable the type-43 raw data flood (R10/R11) so it doesn't dominate
    //     BLE airtime (~2 × 1.9 KB/s) and starve the historical offload.
    try {
      await this._sendCommand(CommandNumber.SEND_R10_R11_REALTIME, new Uint8Array([0x00]));
    } catch (e) { this._emit('error', e); }

    // 3. Start realtime HR/RR stream IMMEDIATELY so the live display works.
    try {
      await this.startRealtime();
    } catch (e) { this._emit('error', e); }

    // 4. Backfill historical data — fire-and-forget so it doesn't block live.
    //     The strap paces history at ~10 rec/s, so a full 14-day drain can take
    //     many minutes. Run it in the background.
    this.downloadHistory().catch((e) => this._emit('error', e));

    // 4b. (5.0 only) Poke the diag characteristic for skin-temp candidates.
    if (this._family === 'whoop5') {
      try { await this.sendDebugSkinTempCommand(); } catch (e) { this._emit('error', e); }
    }

    // 5. Initial battery sample
    this.getBatteryLevel().catch(() => {});
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    if (this._batteryPollInterval) {
      clearInterval(this._batteryPollInterval);
      this._batteryPollInterval = null;
    }
    try { await this.stopRealtime(); } catch {}
    if (this.server) {
      try { this.server.disconnect(); } catch {}
    }
    // Explicitly null the gatt server + cached device so a fresh
    // connect() or getDevices() doesn't reuse stale GATT state.
    if (this.device) {
      try { this.device.gatt.disconnect(); } catch {}
    }
    this.server = null;
    this.connected = false;
    this._setState('disconnected');
    // Keep this.device alive so we can call forget() if needed.
  }

  /** Forget the paired device in the browser, so the next connect
   *  must go through the device-picker again. */
  async forgetDevice() {
    if (this.device && typeof this.device.forget === 'function') {
      try {
        await this.device.forget();
      } catch (err) {
        console.warn('[client] device.forget() failed', err);
      }
    }
    this._intentionalDisconnect = true;
    this.server = null;
    this.connected = false;
    this.device = null;
    this._setState('disconnected');
  }

  _onDisconnected() {
    this.connected = false;
    if (this._batteryPollInterval) {
      clearInterval(this._batteryPollInterval);
      this._batteryPollInterval = null;
    }
    // On a disconnect mid-dump, emit historyError once and reject the dump
    // coroutine's queue waiter so it unwinds immediately instead of stalling on
    // the 30s queue timeout. The _fromDisconnect flag tells downloadHistory not
    // to emit a second historyError as it unwinds; resetting the in-flight flag
    // lets a reconnect start a fresh dump.
    if (this._historicalDumpInFlight) {
      const err = new Error('disconnected during dump');
      err._fromDisconnect = true;
      this._historicalDumpInFlight = false;
      this._emit('historyError', err);
      this._metaQueue.drain(err);
    } else {
      this._metaQueue.clear();
    }
    if (this._intentionalDisconnect) return;
    this._setState('reconnecting');
    setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
    this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
  }

  async _tryReconnect() {
    try { await this._connect(); }
    catch (err) {
      this._setState('reconnecting');
      this._emit('error', err);
      setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
      this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
    }
  }

  // ----- notification handlers --------------------------------------------

  // Decode a raw notification into WhoopPackets. A 4.0 notification is a single
  // framed packet; a 5.0 notification may concatenate several Puffin frames.
  // Returns { packets, error } — error is only set on the 4.0 single-frame path
  // so _onData can surface it exactly as before.
  _decodeNotification(e) {
    const v = bytesOf(e.target.value);
    if (this._family === 'whoop5') return { packets: decodeV5(v) };
    try { return { packets: [WhoopPacket.fromData(v)] }; }
    catch {
      // Unframed notification — try 96-byte REALTIME_RAW_DATA (SpO₂/temp/accel).
      const sensor = parseRealtimeRaw(v);
      if (sensor) {
        this._emit('sensorSample', sensor);
        return { packets: [], error: null };
      }
      // When raw data mode is active, emit raw notification for inspection.
      if (this._rawActive) {
        const hex = Array.from(v.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        this._emit('rawNotification', { length: v.length, hex });
      }
      return { packets: [], error: null };
    }
  }

  _onData(e) {
    const { packets, error } = this._decodeNotification(e);
    if (error) { this._emit('error', error); return; }
    for (const pkt of packets) this._handleDataPacket(pkt);
  }

  _handleDataPacket(pkt) {
    switch (pkt.type) {
      case PacketType.REALTIME_DATA: {
        const decoded = decodePacket(pkt);
        this._emit('sample', decoded);
        break;
      }
      case PacketType.HISTORICAL_DATA: {
        if (this._family === 'whoop5') {
          // 5.0 historical bodies use a K-revision-specific layout that is NOT
          // the 4.0 one — running parseHistorical here would fabricate a heart
          // rate from the wrong offset. Instead emit the raw frame plus its
          // k-revision (payload[1] = raw notification byte[9], goose's
          // discriminator; k=18/24 carry the skin-temp/resp candidates) so the
          // app can capture it for offline offset discovery. No value decode is
          // performed. See docs/whoop5-candidate-capture.md.
          this._emit('rawCandidate', {
            kRevision: pkt.seq,
            cmd: pkt.cmd,
            data: Uint8Array.from(pkt.data),
          });
          break;
        }
        try {
          const rec = parseHistorical(pkt.data, pkt.seq);
          if (rec) this._emit('historicalSample', rec);
        } catch (err) { this._emit('error', err); }
        break;
      }
      case PacketType.METADATA:
      case PacketType.PUFFIN_METADATA: {
        // PUFFIN_METADATA (5.0) is the history-end signal, same as METADATA.
        const meta = decodePacket(pkt);
        this._metaQueue.push(meta);
        this._emit('metadata', meta);
        break;
      }
      case PacketType.CONSOLE_LOGS: {
        const decoded = decodePacket(pkt);
        if (decoded.text) this._emit('log', decoded.text);
        break;
      }
      case PacketType.REALTIME_RAW_DATA:
      case PacketType.REALTIME_IMU_DATA_STREAM:
      case PacketType.HISTORICAL_IMU_DATA_STREAM: {
        this._emit('imu', { packetType: pkt.type, data: pkt.data });
        break;
      }
      default:
        // Silently drop unknown types.
        break;
    }
  }

  _onResponse(e) {
    const { packets } = this._decodeNotification(e);
    for (const pkt of packets) this._handleResponsePacket(pkt);
  }

  _handleResponsePacket(pkt) {
    // Cache the well-known responses for callers waiting on them.
    if (pkt.cmd === CommandNumber.GET_BATTERY_LEVEL) {
      const pct = parseBatteryResponse(pkt.data);
      if (pct != null) { this.batteryPct = pct; this._emit('battery', pct); }
    } else if (pkt.cmd === CommandNumber.GET_CLOCK) {
      const unix = parseClockResponse(pkt.data);
      if (unix != null) { this.lastClockUnix = unix; this._emit('clock', unix); }
    } else if (pkt.cmd === CommandNumber.GET_HELLO_HARVARD) {
      const hello = parseHelloResponse(pkt.data);
      if (hello && !hello.partial) {
        this.charging = hello.charging;
        this.isWorn = hello.isWorn;
        this.serial = hello.serial ?? this.serial;
        this._emit('hello', hello);
      }
    }
    this._emit('response', { cmd: pkt.cmd, data: pkt.data });
  }

  _onEvent(e) {
    const { packets } = this._decodeNotification(e);
    for (const pkt of packets) this._handleEventPacket(pkt);
  }

  _handleEventPacket(pkt) {
    if (!EVENT_TYPES.includes(pkt.type)) return;
    const evt = decodePacket(pkt);

    // Surface state-relevant ones onto the client itself + emit:
    switch (pkt.cmd) {
      case EventNumber.WRIST_ON:  this.isWorn = true; break;
      case EventNumber.WRIST_OFF: this.isWorn = false; break;
      case EventNumber.CHARGING_ON:  this.charging = true; break;
      case EventNumber.CHARGING_OFF: this.charging = false; break;
      case EventNumber.RTC_LOST:
        // Re-sync clock ASAP.
        this.setClock().catch(() => {});
        break;
      case EventNumber.HIGH_FREQ_SYNC_PROMPT:
        // Strap is asking for a sync. Drain history.
        this.downloadHistory().catch(() => {});
        break;
    }
    this._emit('event', evt);
  }

  // ----- command senders --------------------------------------------------

  async _sendCommand(cmd, payload = new Uint8Array()) {
    if (!this.charCmd) throw new Error('Not connected');
    const frame = this._family === 'whoop5'
      ? buildV5CommandFrame(this._seq, cmd, payload)
      : buildCommandFrame(cmd, payload, this._seq);
    this._seq = (this._seq + 1) & 0xff;
    await this.charCmd.writeValue(frame);
  }

  async startRealtime() {
    if (this._family === 'whoop5') return this.startPhysiologyCapture();
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
  }

  async stopRealtime() {
    if (this._family === 'whoop5') return this.stopPhysiologyCapture();
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x00]));
  }

  // 5.0 realtime needs more than the single TOGGLE_REALTIME_HR: the strap only
  // streams optical (R10/R11) + IMU once a sequence of stream toggles is sent,
  // spaced out so the strap can act on each. Each command is a "revision
  // boolean" payload [0x01, enabled]. Stop reverses the order with enabled=0.
  async startPhysiologyCapture() {
    const seq = [
      CommandNumber.TOGGLE_REALTIME_HR, CommandNumber.SEND_R10_R11_REALTIME,
      CommandNumber.TOGGLE_IMU_MODE, CommandNumber.TOGGLE_PERSISTENT_R21,
      CommandNumber.ENABLE_OPTICAL_DATA, CommandNumber.TOGGLE_OPTICAL_MODE,
      CommandNumber.TOGGLE_PERSISTENT_R20,
    ];
    await this._runSpacedCommands(seq, 0x01);
  }

  async stopPhysiologyCapture() {
    const seq = [
      CommandNumber.TOGGLE_PERSISTENT_R20, CommandNumber.TOGGLE_OPTICAL_MODE,
      CommandNumber.ENABLE_OPTICAL_DATA, CommandNumber.TOGGLE_PERSISTENT_R21,
      CommandNumber.TOGGLE_IMU_MODE, CommandNumber.SEND_R10_R11_REALTIME,
      CommandNumber.TOGGLE_REALTIME_HR,
    ];
    await this._runSpacedCommands(seq, 0x00);
  }

  async _runSpacedCommands(cmds, enabled) {
    for (let i = 0; i < cmds.length; i++) {
      await this._sendCommand(cmds[i], new Uint8Array([0x01, enabled & 0x01]));
      if (i < cmds.length - 1 && this._physiologyGapMs > 0) await delay(this._physiologyGapMs);
    }
  }

  async getBatteryLevel() {
    if (!this.connected) return;
    try { await this._sendCommand(CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00])); }
    catch (err) { console.warn('[WhoopClient] battery poll failed', err); }
  }

  async sendHello() {
    await this._sendCommand(CommandNumber.GET_HELLO_HARVARD, new Uint8Array([0x00]));
  }

  async getClock() {
    return new Promise(async (resolve) => {
      let resolved = false;
      const dispose = this.on('clock', (unix) => {
        if (resolved) return;
        resolved = true;
        dispose();
        resolve(unix);
      });
      setTimeout(() => { if (!resolved) { dispose(); resolve(null); } }, 3000);
      await this._sendCommand(CommandNumber.GET_CLOCK, new Uint8Array([0x00]));
    });
  }

  async setClock(unix = Math.floor(Date.now() / 1000)) {
    if (this._family === 'whoop5') {
      // 5.0 wants 8 bytes: u32 LE seconds + u32 LE subseconds (1/32768ths).
      const sub = Math.floor((Date.now() % 1000) * 32768 / 1000);
      const buf = new Uint8Array(8);
      writeU32LE(buf, 0, unix);
      writeU32LE(buf, 4, sub);
      await this._sendCommand(CommandNumber.SET_CLOCK, buf);
      return;
    }
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, unix);
    await this._sendCommand(CommandNumber.SET_CLOCK, buf);
  }

  async getDataRange() {
    await this._sendCommand(CommandNumber.GET_DATA_RANGE, new Uint8Array([0x00]));
  }

  async runHaptics(pattern = 0) {
    await this._sendCommand(CommandNumber.RUN_HAPTICS_PATTERN, new Uint8Array([pattern & 0xff]));
  }

  async abortHistoricalTransmits() {
    await this._sendCommand(CommandNumber.ABORT_HISTORICAL_TRANSMITS, new Uint8Array([0x00]));
  }

  /**
   * Start the raw-data stream: REALTIME_RAW_DATA (type 43) + IMU stream
   * packets (type 51) start flowing on the data char. Body layouts are
   * still being mapped — they get emitted as 'imu' events with raw bytes
   * so the UI can capture and inspect them.
   */
  async startRawData() {
    await this._sendCommand(CommandNumber.START_RAW_DATA, new Uint8Array([0x01]));
    this._rawActive = true;
  }

  async stopRawData() {
    await this._sendCommand(CommandNumber.STOP_RAW_DATA, new Uint8Array([0x01]));
    this._rawActive = false;
  }

  /**
   * (5.0 only) Write the debug-menu skin-temperature trigger to the diag
   * characteristic: a raw 2-byte write [0x73, 0x0a] — NO V5 framing, no CRC,
   * fire-and-forget, exactly as goose does. It prompts the strap to emit
   * skin-temp candidate packets (k-revision 18/24) on the data char, which then
   * surface as 'rawCandidate' events for offline analysis. No-op (not an error)
   * if the diag characteristic wasn't acquired.
   */
  async sendDebugSkinTempCommand() {
    if (!this.charDiag) return;
    await this.charDiag.writeValue(new Uint8Array([0x73, 0x0a]));
  }

  async toggleImuMode(enable = true) {
    await this._sendCommand(CommandNumber.TOGGLE_IMU_MODE, new Uint8Array([enable ? 0x01 : 0x00]));
  }

  /**
   * Toggle the standard BLE Heart Rate Profile (Service 0x180D). When on,
   * any third-party fitness app (Strava, Zwift, Peloton, Apple Watch
   * companions, etc.) can pair with the strap as a regular HR monitor.
   * Huge unlock — the strap already does all the work, this just exposes it.
   */
  async toggleGenericHrProfile(enable = true) {
    await this._sendCommand(CommandNumber.TOGGLE_GENERIC_HR_PROFILE, new Uint8Array([enable ? 0x01 : 0x00]));
    this._genericHrEnabled = enable;
  }

  // ----- alarm controls ---------------------------------------------------
  //
  // The strap can wake you with a vibration at a set time — even if your
  // phone/mac is in another room. Three commands:
  //   SET_ALARM_TIME (66)  — arm: payload = u32 LE unix epoch
  //   RUN_ALARM (68)       — fire immediately (also tests the haptic)
  //   DISABLE_ALARM (69)   — cancel a previously-armed alarm

  async setAlarm(unixTime) {
    if (!Number.isFinite(unixTime) || unixTime <= 0) throw new Error('alarm time invalid');
    if (this._family === 'whoop5') {
      // 5.0 alarm is a 20-byte payload: set sub-cmd, alarm id, u32 seconds,
      // u16 subseconds, an 8-byte haptic waveform, loop control, and duration.
      const buf = new Uint8Array(20);
      buf[0] = 0x04;            // sub-command: set
      buf[1] = 0x01;            // alarm id
      writeU32LE(buf, 2, unixTime);
      const sub = Math.floor((Date.now() % 1000) * 32768 / 1000);
      buf[6] = sub & 0xff;
      buf[7] = (sub >>> 8) & 0xff;
      buf.set([47, 152, 0, 0, 0, 0, 0, 0], 8);  // default WHOOP haptic waveform
      // bytes 16-17 loop control = 0
      buf[18] = 7;             // overall loop count
      buf[19] = 30;            // duration seconds
      await this._sendCommand(CommandNumber.SET_ALARM_TIME, buf);
      return;
    }
    const buf = new Uint8Array(4);
    writeU32LE(buf, 0, unixTime);
    await this._sendCommand(CommandNumber.SET_ALARM_TIME, buf);
  }

  async runAlarmNow() {
    await this._sendCommand(CommandNumber.RUN_ALARM, new Uint8Array([0x00]));
  }

  async disableAlarm() {
    await this._sendCommand(CommandNumber.DISABLE_ALARM, new Uint8Array([0x00]));
  }

  /**
   * cmd 98 GET_EXTENDED_BATTERY_INFO — voltage / current / temperature /
   * cycle count / state-of-charge. Response layout is unconfirmed; we just
   * fire the command and the response flows out as a 'response' event
   * (cmd=98) so the caller can inspect the raw bytes.
   */
  async getExtendedBatteryInfo() {
    await this._sendCommand(CommandNumber.GET_EXTENDED_BATTERY_INFO, new Uint8Array([0x00]));
  }

  /**
   * cmd 123 SELECT_WRIST — tell the strap which wrist it's on (0=left, 1=right).
   * Affects motion classification.
   */
  async selectWrist(side = 'left') {
    const byte = side === 'right' ? 0x01 : 0x00;
    await this._sendCommand(CommandNumber.SELECT_WRIST, new Uint8Array([byte]));
  }

  /**
   * cmd 96 ENTER_HIGH_FREQ_SYNC — bulk-flash dump fast mode. Pairs with
   * exitHighFreqSync(). The strap should switch to maximum BLE throughput
   * for a fast historical drain.
   */
  async enterHighFreqSync() {
    await this._sendCommand(CommandNumber.ENTER_HIGH_FREQ_SYNC, new Uint8Array([0x00]));
  }

  async exitHighFreqSync() {
    await this._sendCommand(CommandNumber.EXIT_HIGH_FREQ_SYNC, new Uint8Array([0x00]));
  }

  // ----- historical data dump ---------------------------------------------
  //
  // Implements the state machine documented in vendor/whoomp/whoomp.js:292-325.
  // The strap floods METADATA + HISTORICAL_DATA packets onto the data
  // characteristic; we ack each batch with HISTORICAL_DATA_RESULT(trim) until
  // HISTORY_COMPLETE arrives.

  async downloadHistory() {
    if (!this.connected) return { samples: 0 };
    if (this._historicalDumpInFlight) return { samples: 0, alreadyRunning: true };
    this._historicalDumpInFlight = true;
    this._metaQueue.clear();
    this._emit('historyStart', {});

    let samplesReceived = 0;
    const onSample = this.on('historicalSample', () => { samplesReceived++; });

    try {
      // Just request the raw dump — no preambles needed. NOOP confirmed that
      // plain SEND_HISTORICAL_DATA returns the type-47 store; ABORT and
      // HIGH_FREQ_SYNC only confuse the strap.
      await this._sendCommand(CommandNumber.SEND_HISTORICAL_DATA, new Uint8Array([0x00]));

      while (true) {
        // Wait for an END or COMPLETE — skip START frames.
        // The strap pauses naturally between chunks (flash writes, internal
        // processing). If we hit a queue timeout, retry instead of crashing
        // out — the strap may just be busy.
        let meta;
        let consecutiveTimeouts = 0;
        while (true) {
          try {
            meta = await this._metaQueue.pop(META_QUEUE_TIMEOUT_MS);
            consecutiveTimeouts = 0;
            if (meta.kind === 'historyEnd' || meta.kind === 'historyComplete') break;
          } catch (err) {
            if (err?.message === 'queue timeout') {
              consecutiveTimeouts++;
              if (consecutiveTimeouts >= 3) throw new Error('backfill idle timeout');
              console.warn('[WhoopClient] backfill idle, retrying…');
              continue;
            }
            throw err;
          }
        }

        if (meta.kind === 'historyComplete') {
          this._emit('historyComplete', { samples: samplesReceived });
          return { samples: samplesReceived };
        }

        // Ack the batch by echoing trim. Payload = [0x01][trim u32 LE][0 u32].
        const ack = new Uint8Array(9);
        ack[0] = 0x01;
        ack[1] = meta.trim & 0xff;
        ack[2] = (meta.trim >>> 8) & 0xff;
        ack[3] = (meta.trim >>> 16) & 0xff;
        ack[4] = (meta.trim >>> 24) & 0xff;
        // bytes 5..9 stay zero
        await this._sendCommand(CommandNumber.HISTORICAL_DATA_RESULT, ack);
        this._emit('historyProgress', { samples: samplesReceived, trim: meta.trim });
      }
    } catch (err) {
      // _onDisconnected already emitted historyError for a disconnect-driven
      // abort; don't double-emit. Other failures (timeout, write error) emit here.
      if (!err?._fromDisconnect) this._emit('historyError', err);
      throw err;
    } finally {
      // Unsubscribe the sample counter first so a stray late notification during
      // the exit-sync round-trip can't touch it.
      onSample();
      this._historicalDumpInFlight = false;
    }
  }
}

// Helpers ----------------------------------------------------------------

function bytesOf(dataView) {
  // The browser hands us a DataView; convert to a plain Uint8Array view.
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

function writeU32LE(buf, off, value) {
  const v = value >>> 0;
  buf[off]     = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
