// Integration tests for WhoopClient with a mocked BLE backend.
// We don't have a strap in CI, so we fake the Web Bluetooth characteristics
// and drive the historical-dump state machine end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoopClient } from '../../../web/js/ble/client.js';
import {
  WhoopPacket, PacketType, CommandNumber, MetadataType, EventNumber, decodeV5,
} from '../../../web/js/ble/packet.js';
import { crc16Modbus, crc32Whoop } from '../../../web/js/ble/crc.js';

/** Frame an arbitrary 5.0 (Puffin) payload [type,seq,cmd,...body] for fire(). */
function v5Frame(type, seq, cmd, body = new Uint8Array()) {
  const raw = new Uint8Array([type, seq, cmd, ...body]);
  const padLen = (4 - (raw.length % 4)) % 4;
  const payload = new Uint8Array(raw.length + padLen);
  payload.set(raw);
  const declaredLen = payload.length + 4;
  const header = new Uint8Array([0xaa, 0x01, declaredLen & 0xff, (declaredLen >> 8) & 0xff, 0x00, 0x01]);
  const hdrCrc = crc16Modbus(header);
  const payCrc = crc32Whoop(payload);
  const frame = new Uint8Array(8 + payload.length + 4);
  frame.set(header);
  frame[6] = hdrCrc & 0xff; frame[7] = (hdrCrc >> 8) & 0xff;
  frame.set(payload, 8);
  const o = 8 + payload.length;
  frame[o] = payCrc & 0xff; frame[o + 1] = (payCrc >>> 8) & 0xff;
  frame[o + 2] = (payCrc >>> 16) & 0xff; frame[o + 3] = (payCrc >>> 24) & 0xff;
  return frame;
}

/** Build a framed METADATA packet for the dump state machine. */
function metaFrame(kind, { unix = 0, trim = 0 } = {}) {
  const data = new Uint8Array(14);
  // bytes 0..4 unix
  data[0] = unix & 0xff;
  data[1] = (unix >> 8) & 0xff;
  data[2] = (unix >> 16) & 0xff;
  data[3] = (unix >> 24) & 0xff;
  // bytes 10..14 trim
  data[10] = trim & 0xff;
  data[11] = (trim >> 8) & 0xff;
  data[12] = (trim >> 16) & 0xff;
  data[13] = (trim >> 24) & 0xff;
  return new WhoopPacket(PacketType.METADATA, 0, kind, data).framed();
}

/** Build a framed HISTORICAL_DATA packet (HR + 1 RR). */
function historicalFrame({ unix = 1716200000, hr = 60, rr = 1000 } = {}) {
  const data = new Uint8Array(32);
  data[4] = unix & 0xff;
  data[5] = (unix >> 8) & 0xff;
  data[6] = (unix >> 16) & 0xff;
  data[7] = (unix >> 24) & 0xff;
  data[14] = hr;
  data[15] = 1;
  data[16] = rr & 0xff;
  data[17] = (rr >> 8) & 0xff;
  return new WhoopPacket(PacketType.HISTORICAL_DATA, 0, 0, data).framed();
}

/** Build a framed EVENT packet. */
function eventFrame(cmd, payload = new Uint8Array([0, 0, 0, 0, 0])) {
  return new WhoopPacket(PacketType.EVENT, 0, cmd, payload).framed();
}

/** Build a framed COMMAND_RESPONSE packet. */
function responseFrame(cmd, payload) {
  return new WhoopPacket(PacketType.COMMAND_RESPONSE, 0, cmd, payload).framed();
}

/** A fake GATT characteristic that records writes + supports notification fire. */
function makeCharacteristic() {
  const listeners = new Set();
  let writes = [];
  return {
    writes,
    listeners,
    writeValue: vi.fn(async (bytes) => { writes.push(bytes); }),
    startNotifications: vi.fn(async () => {}),
    addEventListener: (event, fn) => { if (event === 'characteristicvaluechanged') listeners.add(fn); },
    /** Fire a notification with a Uint8Array — wraps it as DataView like the browser does. */
    fire(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const fn of listeners) fn({ target: { value: dv } });
    },
  };
}

// UUID-aware fake: getPrimaryService throws for the service UUID the device
// doesn't expose (like a real strap), so the client's whoop5→whoop4 probe
// falls back correctly. Pass 'whoop5' to simulate a Puffin strap.
function makeFakeDevice(family = 'whoop4', opts = { withDiag: true }) {
  const slots = family === 'whoop5'
    ? { svc: 'fd4b0001', cmd: 'fd4b0002', resp: 'fd4b0003', event: 'fd4b0004', data: 'fd4b0005', diag: 'fd4b0007' }
    : { svc: '61080001', cmd: '61080002', resp: '61080003', event: '61080004', data: '61080005', diag: '61080007' };
  const cmd = makeCharacteristic();
  const resp = makeCharacteristic();
  const data = makeCharacteristic();
  const event = makeCharacteristic();
  const diag = makeCharacteristic();
  const service = {
    getCharacteristic: vi.fn(async (uuid) => {
      if (uuid.startsWith(slots.cmd)) return cmd;
      if (uuid.startsWith(slots.resp)) return resp;
      if (uuid.startsWith(slots.event)) return event;
      if (uuid.startsWith(slots.data)) return data;
      if (opts.withDiag && uuid.startsWith(slots.diag)) return diag;
      throw Object.assign(new Error('unknown UUID ' + uuid), { name: 'NotFoundError' });
    }),
  };
  const gatt = {
    connected: true,
    connect: vi.fn(async () => ({
      getPrimaryService: vi.fn(async (uuid) => {
        if (uuid.startsWith(slots.svc)) return service;
        // Web Bluetooth rejects an absent service with a NotFoundError; the
        // client only falls back to 4.0 on exactly that error name.
        throw Object.assign(new Error('no such service ' + uuid), { name: 'NotFoundError' });
      }),
      connected: true,
      disconnect: vi.fn(),
    })),
  };
  return {
    id: 'mock-strap',
    gatt,
    addEventListener: vi.fn(),
    _chars: { cmd, resp, data, event, diag },
  };
}

describe('WhoopClient mocked BLE', () => {
  let client, device;

  beforeEach(() => {
    device = makeFakeDevice();
    client = new WhoopClient();
  });

  it('parses realtime sample notifications', async () => {
    await client.connectToDevice(device);
    // We don't await postConnectFlow — it sends async commands; we just
    // verify the sample handler works.
    const samples = [];
    client.on('sample', (s) => samples.push(s));

    // Build a realtime data packet: HR=72 at data[5], rrnum=1, rr=850 at data[7..9]
    const payload = new Uint8Array(32);
    payload[5] = 72;
    payload[6] = 1;
    payload[7] = 850 & 0xff;
    payload[8] = (850 >> 8) & 0xff;
    const realtime = new WhoopPacket(PacketType.REALTIME_DATA, 0, 0, payload).framed();
    device._chars.data.fire(realtime);

    expect(samples).toHaveLength(1);
    expect(samples[0].heartRateBpm).toBe(72);
    expect(samples[0].rrIntervalsMs).toEqual([850]);
  });

  it('runs the historical-dump state machine to completion', async () => {
    await client.connectToDevice(device);

    const historicalSamples = [];
    const progressEvents = [];
    client.on('historicalSample', (s) => historicalSamples.push(s));
    client.on('historyProgress', (e) => progressEvents.push(e));

    // Drain initial commands the post-connect flow has already queued — we
    // only care about commands AFTER downloadHistory() is invoked.
    const writesBefore = device._chars.cmd.writes.length;

    // Start dump in parallel with the simulator below
    const dumpPromise = client.downloadHistory();

    // The strap simulator: send START, three samples, END (trim=42), then
    // wait for our ACK, then send another END (trim=99), then COMPLETE.
    queueMicrotask(async () => {
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_START, { unix: 1, trim: 0 }));
      device._chars.data.fire(historicalFrame({ unix: 100, hr: 60, rr: 1000 }));
      device._chars.data.fire(historicalFrame({ unix: 101, hr: 61, rr: 990 }));
      device._chars.data.fire(historicalFrame({ unix: 102, hr: 62, rr: 980 }));
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_END, { unix: 102, trim: 42 }));

      // Yield so the client can process and send its ACK.
      await new Promise(r => setTimeout(r, 0));

      // Second batch + COMPLETE
      device._chars.data.fire(historicalFrame({ unix: 200, hr: 70 }));
      device._chars.data.fire(metaFrame(MetadataType.HISTORY_COMPLETE));
    });

    const result = await dumpPromise;
    expect(result.samples).toBe(4);
    expect(historicalSamples).toHaveLength(4);
    expect(historicalSamples[0].heartRateBpm).toBe(60);
    expect(historicalSamples[0].rrIntervalsMs).toEqual([1000]);

    // Verify we sent SEND_HISTORICAL_DATA + HISTORICAL_DATA_RESULT(trim=42)
    const writesAfter = device._chars.cmd.writes.slice(writesBefore);
    // The actual commands written, parsed back into WhoopPackets:
    const parsedCommands = writesAfter.map(w => WhoopPacket.fromData(w));
    const cmdNums = parsedCommands.map(p => p.cmd);
    expect(cmdNums).toContain(CommandNumber.SEND_HISTORICAL_DATA);
    expect(cmdNums).toContain(CommandNumber.HISTORICAL_DATA_RESULT);

    // The ACK payload should encode trim=42
    const ackPkt = parsedCommands.find(p => p.cmd === CommandNumber.HISTORICAL_DATA_RESULT);
    expect(ackPkt).toBeDefined();
    const trim = ackPkt.data[1] | (ackPkt.data[2] << 8) | (ackPkt.data[3] << 16) | (ackPkt.data[4] << 24);
    expect(trim).toBe(42);
    expect(ackPkt.data[0]).toBe(0x01);

    // historyProgress fires once per ACKed batch
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0].trim).toBe(42);
  });

  it('returns early if a dump is already in flight', async () => {
    await client.connectToDevice(device);
    // Mark in-flight without actually running one
    client._historicalDumpInFlight = true;
    const result = await client.downloadHistory();
    expect(result.alreadyRunning).toBe(true);
  });

  it('decodes WRIST_ON event and updates isWorn', async () => {
    await client.connectToDevice(device);
    const events = [];
    client.on('event', (e) => events.push(e));

    device._chars.event.fire(eventFrame(EventNumber.WRIST_ON));
    expect(client.isWorn).toBe(true);
    expect(events[events.length - 1].semantic).toBe('wristOn');

    device._chars.event.fire(eventFrame(EventNumber.WRIST_OFF));
    expect(client.isWorn).toBe(false);
  });

  it('caches battery from response packet', async () => {
    await client.connectToDevice(device);
    // u16 LE at offset 2 = 857 → 85.7%
    const payload = new Uint8Array([0, 0, 857 & 0xff, (857 >> 8) & 0xff]);
    device._chars.resp.fire(responseFrame(CommandNumber.GET_BATTERY_LEVEL, payload));
    expect(client.batteryPct).toBeCloseTo(85.7, 1);
  });

  it('caches strap state from GET_HELLO_HARVARD response', async () => {
    await client.connectToDevice(device);
    const payload = new Uint8Array(130);
    payload[7] = 1;     // charging
    payload[116] = 1;   // worn
    device._chars.resp.fire(responseFrame(CommandNumber.GET_HELLO_HARVARD, payload));
    expect(client.charging).toBe(true);
    expect(client.isWorn).toBe(true);
  });

  it('reacts to HIGH_FREQ_SYNC_PROMPT by kicking off downloadHistory', async () => {
    await client.connectToDevice(device);
    const spy = vi.spyOn(client, 'downloadHistory').mockResolvedValue({ samples: 0 });
    device._chars.event.fire(eventFrame(EventNumber.HIGH_FREQ_SYNC_PROMPT));
    expect(spy).toHaveBeenCalled();
  });

  it('reacts to RTC_LOST by calling setClock', async () => {
    await client.connectToDevice(device);
    const spy = vi.spyOn(client, 'setClock').mockResolvedValue();
    device._chars.event.fire(eventFrame(EventNumber.RTC_LOST));
    expect(spy).toHaveBeenCalled();
  });

  it('emits historyError if disconnected mid-dump', async () => {
    await client.connectToDevice(device);
    const errors = [];
    client.on('historyError', (e) => errors.push(e));
    // Pretend a dump is mid-flight
    client._historicalDumpInFlight = true;
    client._onDisconnected();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/disconnect/);
    expect(client._historicalDumpInFlight).toBe(false);
  });

  describe('WHOOP 5.0 family detection', () => {
    const CLIENT_HELLO = [
      0xaa, 0x01, 0x08, 0x00, 0x00, 0x01, 0xe6, 0x71,
      0x23, 0x01, 0x91, 0x01, 0x36, 0x3e, 0x5c, 0x8d,
    ];

    it('detects a 5.0 strap and writes CLIENT_HELLO first', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      await c.connectToDevice(dev5);
      expect(c._family).toBe('whoop5');
      expect(Array.from(dev5._chars.cmd.writes[0])).toEqual(CLIENT_HELLO);
    });

    it('falls back to 4.0 when the 5.0 service is absent', async () => {
      const dev4 = makeFakeDevice('whoop4');
      const c = new WhoopClient();
      await c.connectToDevice(dev4);
      expect(c._family).toBe('whoop4');
      // No CLIENT_HELLO on 4.0.
      expect(dev4._chars.cmd.writes[0] && Array.from(dev4._chars.cmd.writes[0])).not.toEqual(CLIENT_HELLO);
    });

    it('propagates a non-NotFoundError from the 5.0 probe instead of mis-detecting as 4.0', async () => {
      const dev = makeFakeDevice('whoop4');
      const origConnect = dev.gatt.connect;
      dev.gatt.connect = vi.fn(async () => {
        const server = await origConnect();
        const realGet = server.getPrimaryService;
        server.getPrimaryService = vi.fn(async (uuid) => {
          if (uuid.startsWith('fd4b0001')) throw Object.assign(new Error('GATT busy'), { name: 'NetworkError' });
          return realGet(uuid);
        });
        return server;
      });
      const c = new WhoopClient();
      await expect(c.connectToDevice(dev)).rejects.toThrow(/GATT busy/);
    });

    it('decodes a V5-framed realtime sample through the same sample path', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      await c.connectToDevice(dev5);
      const samples = [];
      c.on('sample', (s) => samples.push(s));
      const payload = new Uint8Array(32);
      payload[5] = 72; payload[6] = 1; payload[7] = 850 & 0xff; payload[8] = (850 >> 8) & 0xff;
      dev5._chars.data.fire(v5Frame(PacketType.REALTIME_DATA, 0, 0, payload));
      expect(samples).toHaveLength(1);
      expect(samples[0].heartRateBpm).toBe(72);
      expect(samples[0].rrIntervalsMs).toEqual([850]);
    });

    it('sends V5-framed commands on a 5.0 strap', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      await c.connectToDevice(dev5);
      const before = dev5._chars.cmd.writes.length;
      await c.getBatteryLevel();
      const cmds = dev5._chars.cmd.writes.slice(before).flatMap(w => decodeV5(w)).map(p => p.cmd);
      expect(cmds).toContain(CommandNumber.GET_BATTERY_LEVEL);
      // and they are genuinely V5 frames (SOF + flag), not 4.0 frames
      const w = dev5._chars.cmd.writes[before];
      expect(w[0]).toBe(0xaa); expect(w[1]).toBe(0x01);
    });

    it('startPhysiologyCapture fires the 7 stream toggles in order on 5.0', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      c._physiologyGapMs = 0;  // no inter-command delay in the test
      // Suppress the background post-connect flow (which also starts realtime),
      // so the only commands captured are this explicit sequence.
      vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
      await c.connectToDevice(dev5);
      const before = dev5._chars.cmd.writes.length;
      await c.startPhysiologyCapture();
      const pkts = dev5._chars.cmd.writes.slice(before).flatMap(w => decodeV5(w));
      expect(pkts.map(p => p.cmd)).toEqual([
        CommandNumber.TOGGLE_REALTIME_HR, CommandNumber.SEND_R10_R11_REALTIME,
        CommandNumber.TOGGLE_IMU_MODE, CommandNumber.TOGGLE_PERSISTENT_R21,
        CommandNumber.ENABLE_OPTICAL_DATA, CommandNumber.TOGGLE_OPTICAL_MODE,
        CommandNumber.TOGGLE_PERSISTENT_R20,
      ]);
      // each is a revision-boolean ON payload [0x01, 0x01]
      expect(Array.from(pkts[0].data.slice(0, 2))).toEqual([0x01, 0x01]);
    });

    it('setClock emits an 8-byte subseconds payload on 5.0', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      c._physiologyGapMs = 0;
      await c.connectToDevice(dev5);
      const before = dev5._chars.cmd.writes.length;
      await c.setClock(1750000000);
      const pkt = dev5._chars.cmd.writes.slice(before).flatMap(w => decodeV5(w))
        .find(p => p.cmd === CommandNumber.SET_CLOCK);
      expect(pkt).toBeDefined();
      expect(pkt.data.length).toBeGreaterThanOrEqual(8);
      const sec = pkt.data[0] | (pkt.data[1] << 8) | (pkt.data[2] << 16) | (pkt.data[3] << 24);
      expect(sec >>> 0).toBe(1750000000);
    });

    it('setAlarm emits a 20-byte haptic payload on 5.0', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      c._physiologyGapMs = 0;
      await c.connectToDevice(dev5);
      const before = dev5._chars.cmd.writes.length;
      await c.setAlarm(1750000000);
      const pkt = dev5._chars.cmd.writes.slice(before).flatMap(w => decodeV5(w))
        .find(p => p.cmd === CommandNumber.SET_ALARM_TIME);
      expect(pkt).toBeDefined();
      // V5 zero-pads the payload to a 4-byte boundary, so the decoded data may
      // carry up to 3 trailing pad bytes past the 20 meaningful ones.
      expect(pkt.data.length).toBeGreaterThanOrEqual(20);
      expect(pkt.data[0]).toBe(0x04);
      const sec = pkt.data[2] | (pkt.data[3] << 8) | (pkt.data[4] << 16) | (pkt.data[5] << 24);
      expect(sec >>> 0).toBe(1750000000);
      expect(Array.from(pkt.data.slice(8, 16))).toEqual([47, 152, 0, 0, 0, 0, 0, 0]);
      expect(pkt.data[19]).toBe(30);
    });

    it('routes a V5 PUFFIN_METADATA history-end into the dump queue', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      await c.connectToDevice(dev5);
      const metas = [];
      c.on('metadata', (m) => metas.push(m));
      const body = new Uint8Array(14);
      body[10] = 7;  // trim
      dev5._chars.data.fire(v5Frame(PacketType.PUFFIN_METADATA, 0, MetadataType.HISTORY_END, body));
      expect(metas).toHaveLength(1);
      expect(metas[0].kind).toBe('historyEnd');
      expect(metas[0].trim).toBe(7);
    });
  });

  describe('WHOOP 5.0 candidate capture (task 8)', () => {
    it('emits a rawCandidate for a 5.0 historical frame and does NOT fabricate a sample', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
      await c.connectToDevice(dev5);

      const candidates = [];
      const samples = [];
      c.on('rawCandidate', (x) => candidates.push(x));
      c.on('historicalSample', (s) => samples.push(s));

      // A historical frame whose k-revision (payload[1]=seq) is 18 = the
      // skin-temp/resp candidate. Body length 5 keeps the payload 4-byte
      // aligned so V5 adds no trailing pad byte. Bytes are arbitrary — the
      // point is we capture them raw and do NOT decode.
      const body = new Uint8Array([1, 2, 3, 4, 5]);
      dev5._chars.data.fire(v5Frame(PacketType.HISTORICAL_DATA, 18, 7, body));

      expect(candidates).toHaveLength(1);
      expect(candidates[0].kRevision).toBe(18);
      expect(candidates[0].cmd).toBe(7);
      expect(Array.from(candidates[0].data)).toEqual([1, 2, 3, 4, 5]);
      // The 4.0 parseHistorical path must NOT run on a 5.0 body — no fake HR.
      expect(samples).toHaveLength(0);
    });

    it('a 4.0 historical frame still decodes into a historicalSample', async () => {
      const dev4 = makeFakeDevice('whoop4');
      const c = new WhoopClient();
      vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
      await c.connectToDevice(dev4);

      const candidates = [];
      const samples = [];
      c.on('rawCandidate', (x) => candidates.push(x));
      c.on('historicalSample', (s) => samples.push(s));

      dev4._chars.data.fire(historicalFrame({ unix: 100, hr: 60, rr: 1000 }));
      expect(candidates).toHaveLength(0);
      expect(samples).toHaveLength(1);
      expect(samples[0].heartRateBpm).toBe(60);
    });

    it('sendDebugSkinTempCommand writes a raw [0x73,0x0a] to diag (no V5 framing)', async () => {
      const dev5 = makeFakeDevice('whoop5');
      const c = new WhoopClient();
      vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
      await c.connectToDevice(dev5);
      expect(c.charDiag).not.toBeNull();

      await c.sendDebugSkinTempCommand();
      expect(dev5._chars.diag.writes).toHaveLength(1);
      expect(Array.from(dev5._chars.diag.writes[0])).toEqual([0x73, 0x0a]);
      // Raw write — not an 0xAA-framed V5 command.
      expect(dev5._chars.diag.writes[0][0]).not.toBe(0xaa);
    });

    it('sendDebugSkinTempCommand is a no-op when the diag char is absent', async () => {
      const dev5 = makeFakeDevice('whoop5', { withDiag: false });
      const c = new WhoopClient();
      vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
      await c.connectToDevice(dev5);
      expect(c.charDiag).toBeNull();
      await expect(c.sendDebugSkinTempCommand()).resolves.toBeUndefined();
      expect(dev5._chars.diag.writes).toHaveLength(0);
    });

    it('_postConnectFlow pokes the diag char on 5.0 only', async () => {
      for (const fam of ['whoop5', 'whoop4']) {
        const dev = makeFakeDevice(fam);
        const c = new WhoopClient();
        vi.spyOn(c, '_postConnectFlow').mockResolvedValue();
        await c.connectToDevice(dev);
        c._postConnectFlow.mockRestore();

        vi.spyOn(c, 'sendHello').mockResolvedValue();
        vi.spyOn(c, 'getClock').mockResolvedValue(null);
        vi.spyOn(c, 'downloadHistory').mockResolvedValue({ samples: 0 });
        vi.spyOn(c, 'startRealtime').mockResolvedValue();
        vi.spyOn(c, 'getBatteryLevel').mockResolvedValue();
        const debugSpy = vi.spyOn(c, 'sendDebugSkinTempCommand');

        await c._postConnectFlow();
        expect(debugSpy).toHaveBeenCalledTimes(fam === 'whoop5' ? 1 : 0);
      }
    });
  });

  describe('command helpers send the right cmd byte', () => {
    let cmdNumbersSent;

    beforeEach(async () => {
      await client.connectToDevice(device);
      cmdNumbersSent = () => device._chars.cmd.writes.map(w => WhoopPacket.fromData(w).cmd);
    });

    it('toggleGenericHrProfile sends cmd 14', async () => {
      const before = cmdNumbersSent().length;
      await client.toggleGenericHrProfile(true);
      expect(cmdNumbersSent().slice(before)).toContain(CommandNumber.TOGGLE_GENERIC_HR_PROFILE);
      expect(client._genericHrEnabled).toBe(true);
      await client.toggleGenericHrProfile(false);
      expect(client._genericHrEnabled).toBe(false);
    });

    it('setAlarm encodes unix u32 LE', async () => {
      const t = 1750000000;
      const before = cmdNumbersSent().length;
      await client.setAlarm(t);
      const writes = device._chars.cmd.writes.slice(before);
      const pkt = WhoopPacket.fromData(writes[writes.length - 1]);
      expect(pkt.cmd).toBe(CommandNumber.SET_ALARM_TIME);
      const encoded = pkt.data[0] | (pkt.data[1] << 8) | (pkt.data[2] << 16) | (pkt.data[3] << 24);
      expect(encoded >>> 0).toBe(t);
    });

    it('setAlarm rejects invalid times', async () => {
      await expect(client.setAlarm(0)).rejects.toThrow();
      await expect(client.setAlarm(NaN)).rejects.toThrow();
      await expect(client.setAlarm(-1)).rejects.toThrow();
    });

    it('runAlarmNow, disableAlarm, getExtendedBatteryInfo send right cmds', async () => {
      const before = cmdNumbersSent().length;
      await client.runAlarmNow();
      await client.disableAlarm();
      await client.getExtendedBatteryInfo();
      const sent = cmdNumbersSent().slice(before);
      expect(sent).toEqual([
        CommandNumber.RUN_ALARM,
        CommandNumber.DISABLE_ALARM,
        CommandNumber.GET_EXTENDED_BATTERY_INFO,
      ]);
    });

    it('selectWrist maps left/right to 0/1', async () => {
      const before = cmdNumbersSent().length;
      await client.selectWrist('left');
      await client.selectWrist('right');
      const writes = device._chars.cmd.writes.slice(before);
      const left = WhoopPacket.fromData(writes[0]);
      const right = WhoopPacket.fromData(writes[1]);
      expect(left.cmd).toBe(CommandNumber.SELECT_WRIST);
      expect(left.data[0]).toBe(0);
      expect(right.data[0]).toBe(1);
    });

    it('enterHighFreqSync + exitHighFreqSync', async () => {
      const before = cmdNumbersSent().length;
      await client.enterHighFreqSync();
      await client.exitHighFreqSync();
      const sent = cmdNumbersSent().slice(before);
      expect(sent).toEqual([CommandNumber.ENTER_HIGH_FREQ_SYNC, CommandNumber.EXIT_HIGH_FREQ_SYNC]);
    });
  });
});
