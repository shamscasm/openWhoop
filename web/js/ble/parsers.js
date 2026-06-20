// Body decoders for each PacketType. Operate on a parsed WhoopPacket's `data`
// field (which is the body AFTER the [type][seq][cmd] header is stripped).
//
// Offsets here come from vendor/whoomp/whoomp.js (REALTIME, METADATA) and
// vendor/whoomp/scripts/parser.py (HISTORICAL). They are NOT the offsets used
// by whoop-reader's parser.py — that one is wrong about the framing.

import { PacketType, MetadataType, EventNumber, EventName } from './packet.js';

function u16le(d, off) { return d[off] | (d[off + 1] << 8); }
function i16le(d, off) {
  const v = u16le(d, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}
function u32le(d, off) {
  return (d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24)) >>> 0;
}

// Experimental WHOOP 4.0 skin-temp raw scale from community Gen4 captures.
// It turns the observed V12/V24 skin_temp_raw values into plausible °C values
// (e.g. 1604 -> 37.7°C), but remains an estimate without per-device reference.
const SKIN_TEMP_RAW_PER_C = 42.5;
function crc32Whoop(data) {
  // WHOOP-specific CRC-32/MPEG2 variant used by the 96-byte REALTIME_RAW_DATA
  // packet. Polynomial 0x04C11DB7, initial 0xFFFFFFFF, final XOR 0x00000000,
  // reflected = false.  Taken from whoop-reader's crc32_whoop().
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] << 24);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) crc = (crc << 1) ^ 0x04C11DB7;
      else crc <<= 1;
    }
    crc >>>= 0;
  }
  return crc >>> 0;
}

// --- REALTIME_RAW_DATA — 96-byte rich sensor packet ------------------------
//
// Same format as whoop-reader's RealtimePacket via USB CDC. When START_RAW_DATA
// (cmd 43) is active on WHOOP 4.0 BLE, the strap emits these as unframed
// notifications. Carries SpO2, skin temperature, accelerometer, PPG amplitude,
// ambient light, and PPG quality alongside HR + RR.
//
// Layout (bytes):
//   0          uint8   sequence number
//   1-2        u16 LE  heart rate (BPM × 100)
//   3-4        u16 LE  RR interval (ms)
//   5          uint8   SpO₂ (%)
//   6          uint8   skin temperature (raw; value − 25 = °C)
//   7-8        i16 LE  accelerometer X
//   9-10       i16 LE  accelerometer Y
//   11-12      i16 LE  accelerometer Z
//   13         uint8   motion intensity
//   14-15      u16 LE  PPG amplitude
//   16-17      u16 LE  ambient light
//   18-19      u16 LE  PPG quality
//   20-91      —       unknown / reserved
//   92-95      u32 LE  CRC-32 (over bytes 0..91)
//
// Returns null if the packet is too short or values are physiologically
// impossible.

export function parseRealtimeRaw(data) {
  if (!data || data.length < 20) return null;

  // CRC-32 verification when the packet is full length.
  if (data.length >= 96) {
    const expected = u32le(data, 92);
    const actual = crc32Whoop(data.subarray(0, 92));
    if (actual !== expected) return null;
  }

  const seq = data[0];
  const hrRaw = u16le(data, 1);
  const heartRateBpm = (hrRaw >= 2000 && hrRaw <= 25000) ? hrRaw / 100 : null;
  const rrRaw = u16le(data, 3);
  const rrIntervalMs = (rrRaw >= 200 && rrRaw <= 2000) ? rrRaw : null;
  const spo2Pct = (data[5] >= 70 && data[5] <= 100) ? data[5] : null;
  const tempRaw = data[6];
  const skinTempC = (tempRaw >= 55 && tempRaw <= 67) ? tempRaw - 25 : null;

  // Must have at least one plausible vital to avoid false positives.
  if (heartRateBpm == null && spo2Pct == null && skinTempC == null) return null;

  return {
    type: 'realtimeRaw',
    receivedAt: Date.now(),
    seq,
    heartRateBpm,
    rrIntervalsMs: rrIntervalMs != null ? [rrIntervalMs] : [],
    spo2Pct,
    skinTempC,
    accelX: i16le(data, 7),
    accelY: i16le(data, 9),
    accelZ: i16le(data, 11),
    motion: data[13],
    rawHex: Array.from(data.subarray(0, 24)).map(b => b.toString(16).padStart(2, '0')).join(' '),
  };
}

// --- REALTIME_DATA (type 40) -----------------------------------------------
//
// `pkt.data[5]` is the heart rate (uint8 BPM) per whoomp.js:201.
// Beyond that the body is not fully decoded — bytes 0..4 look like a
// timestamp/header prefix, byte 5 = HR, byte 6 = rrnum, bytes 7+ = RR
// intervals and accel/gyro arrays per the RawDataStreamResult comment.

export function parseRealtime(data, { recvAt = Date.now() } = {}) {
  if (data.length < 7) return { heartRateBpm: null, raw: data };

  const heartRateBpm = (data[5] >= 20 && data[5] <= 250) ? data[5] : null;
  const rrnum = Math.min(4, data[6] ?? 0);

  // RR intervals (up to 4 × u16 LE) start at offset 7. Stay safe if the
  // packet is short — bytes-out-of-range read as 0 in the firmware too.
  const rr = [];
  for (let i = 0; i < rrnum && 7 + i * 2 + 1 < data.length; i++) {
    const v = u16le(data, 7 + i * 2);
    if (v >= 200 && v <= 2000) rr.push(v);
  }

  return {
    type: 'realtime',
    receivedAt: recvAt,
    heartRateBpm,
    rrIntervalsMs: rr,
    raw: data,
  };
}

// --- HISTORICAL_DATA (type 47) ---------------------------------------------
//
// Per vendor/whoomp/scripts/parser.py:142-159:
//   unix, subsec, unk, heart = struct.unpack("<LHLB", pkt.data[4:4+11])
//   rrnum at data[15], rr at data[16..24] (4 × u16 LE).
//
// `unk` is opaque (flash record index). We carry it through as `flashIndex`
// because the strap uses it as the "trim" pointer in HISTORICAL_DATA_RESULT
// ACKs.

export function parseHistorical(data, version = null) {
  if (data.length < 24) throw new Error(`HISTORICAL body too short: ${data.length}`);
  const unix = u32le(data, 4);
  const subsec = u16le(data, 8);
  const flashIndex = u32le(data, 10);
  const heart = data[14];
  const rrnum = Math.min(4, data[15] ?? 0);
  const rr = [];
  for (let i = 0; i < rrnum; i++) {
    const v = u16le(data, 16 + i * 2);
    if (v >= 200 && v <= 2000) rr.push(v);
  }

  // v24 extended sensor fields (WHOOP 4.0 DSP record).
  // Offsets from NOOP's verified v24 layout: spo2_red@68, spo2_ir@70,
  // skin_temp_raw@72, resp_rate_raw@80 within the on-wire frame.
  // Our data starts at frame[7], so offset in data = frame_offset - 7.
  const spo2Red = data.length >= 63 ? u16le(data, 61) : null;
  const spo2Ir = data.length >= 65 ? u16le(data, 63) : null;
  const skinTempRaw = data.length >= 67 ? u16le(data, 65) : null;
  const respRateRaw = data.length >= 75 ? u16le(data, 73) : null;
  const respRateRpm = respRateRaw != null ? respRateRaw / 200 : null;
  const skinTempCandidateC = skinTempRaw != null ? skinTempRaw / SKIN_TEMP_RAW_PER_C : null;

  return {
    type: 'historical',
    version,
    _dataLen: data.length,
    unix,
    subsec,
    flashIndex,
    isoUtc: new Date(unix * 1000).toISOString(),
    heartRateBpm: (heart >= 20 && heart <= 250) ? heart : null,
    rrIntervalsMs: rr,
    spo2Red,
    spo2Ir,
    skinTempRaw,
    skinTempC: (skinTempCandidateC != null && skinTempCandidateC >= 20 && skinTempCandidateC <= 45)
      ? skinTempCandidateC
      : null,
    respRateRaw,
    respRateRpm: (respRateRpm != null && respRateRpm >= 4 && respRateRpm <= 40) ? respRateRpm : null,
  };
}

// --- METADATA (type 49) ----------------------------------------------------
//
// cmd byte = MetadataType (HISTORY_START/END/COMPLETE).
// For HISTORY_END the data layout is:
//   data[0..4]  u32 LE unix
//   data[4..6]  u16 LE subsec
//   data[6..10] u32 LE unk
//   data[10..14] u32 LE trim   <-- ack target
// HISTORY_START has the same first 10 bytes; HISTORY_COMPLETE has fewer.

export function parseMetadata(cmd, data) {
  const kind =
    cmd === MetadataType.HISTORY_START    ? 'historyStart'    :
    cmd === MetadataType.HISTORY_END      ? 'historyEnd'      :
    cmd === MetadataType.HISTORY_COMPLETE ? 'historyComplete' : `unknown:${cmd}`;

  const out = { type: 'metadata', kind, cmd };

  if (kind === 'historyEnd' && data.length >= 14) {
    out.unix = u32le(data, 0);
    out.subsec = u16le(data, 4);
    out.unk = u32le(data, 6);
    out.trim = u32le(data, 10);
  } else if (kind === 'historyStart' && data.length >= 10) {
    out.unix = u32le(data, 0);
    out.subsec = u16le(data, 4);
    out.unk = u32le(data, 6);
  }
  return out;
}

// --- EVENT (type 48) -------------------------------------------------------
//
// cmd byte = EventNumber. Most events carry a timestamp at data[1..5]
// (WRIST_ON/OFF confirmed; pattern seems consistent). Only the handful that
// the UI cares about get pulled out of `data`; the rest are tagged and passed
// through.

export function parseEvent(cmd, data) {
  const name = EventName[cmd] ?? `UNKNOWN_${cmd}`;
  const evt = { type: 'event', cmd, name };

  // Most events have [u8 flag, u32 LE unix, ...] for the first 5 bytes. Skip
  // the candidate events whose body layout is UNVERIFIED — decoding a unix from
  // them would be the same fabrication we're avoiding for their values.
  const isCandidate = cmd === EventNumber.TEMPERATURE_LEVEL ||
                      cmd === EventNumber.STRAP_CONDITION_REPORT;
  if (data.length >= 5 && !isCandidate) evt.unix = u32le(data, 1);

  switch (cmd) {
    case EventNumber.WRIST_ON:
      evt.semantic = 'wristOn';
      break;
    case EventNumber.WRIST_OFF:
      evt.semantic = 'wristOff';
      break;
    case EventNumber.CHARGING_ON:
      evt.semantic = 'chargingOn';
      break;
    case EventNumber.CHARGING_OFF:
      evt.semantic = 'chargingOff';
      break;
    case EventNumber.DOUBLE_TAP:
      evt.semantic = 'doubleTap';
      break;
    case EventNumber.BATTERY_LEVEL:
      // Async push of battery; format unconfirmed but probably u16 LE at offset 2.
      if (data.length >= 4) evt.batteryPct = u16le(data, 2) / 10;
      evt.semantic = 'batteryLevel';
      break;
    case EventNumber.RTC_LOST:
      evt.semantic = 'rtcLost';
      break;
    case EventNumber.TEMPERATURE_LEVEL:
      // 5.0 skin-temperature event. The body layout is UNVERIFIED — goose
      // treats this as a presence signal only — so we tag it and pass the raw
      // bytes through for offline analysis rather than decoding a temperature.
      evt.semantic = 'temperatureLevel';
      evt.raw = data;
      break;
    case EventNumber.STRAP_CONDITION_REPORT:
      evt.semantic = 'strapConditionReport';
      evt.raw = data;
      break;
    case EventNumber.HIGH_FREQ_SYNC_PROMPT:
      evt.semantic = 'syncPrompt';
      break;
    case EventNumber.ERROR:
      evt.semantic = 'error';
      break;
  }
  return evt;
}

// --- COMMAND_RESPONSE (type 36) --------------------------------------------
//
// The strap echoes our command number. Response payload varies per command;
// the known ones:
//   GET_BATTERY_LEVEL (26)  → data[2..4] u16 LE battery×10
//   GET_CLOCK (11)          → data[2..6] u32 LE unix
//   REPORT_VERSION_INFO (7) → 3-byte header + 16 × u32 LE versions
//   GET_HELLO_HARVARD (35)  → 117+ bytes (see parseHello)

export function parseResponse(cmd, data) {
  return { type: 'response', cmd, name: CommandNameOrUnknown(cmd), data };
}

// Avoid circular import while keeping the helper here.
function CommandNameOrUnknown(cmd) {
  // Lazy lookup — packet.js exports CommandName but we don't want a cycle.
  // The caller can re-resolve if it cares.
  return cmd;
}

export function parseBatteryResponse(data) {
  if (data.length < 4) return null;
  return u16le(data, 2) / 10;  // 0..100.0 %
}

export function parseClockResponse(data) {
  if (data.length < 6) return null;
  return u32le(data, 2);  // unix seconds
}

export function parseDataRangeResponse(data) {
  // Speculative layout: assume [hdr(2), unix_start u32, unix_end u32] = 10 bytes.
  // Both repos define cmd 34 but never invoke it. Treat fields as best-effort
  // and fall back to null if shorter than expected.
  if (data.length < 10) return null;
  return {
    startUnix: u32le(data, 2),
    endUnix:   u32le(data, 6),
  };
}

export function parseHelloResponse(data) {
  // GET_HELLO_HARVARD response. Layout from whoomp.js + agent reverse-eng.
  // Best-effort extraction; the rest is unstructured telemetry.
  if (data.length < 117) return { raw: data, partial: true };

  const charging = data[7] === 1;
  const isWorn = data[116] === 1;

  // ASCII serial at bytes 9..17 ("4C....."), 9 ASCII chars.
  let serial = null;
  const s = data.subarray(9, 18);
  if (s.every(b => b >= 0x20 && b < 0x7f)) {
    serial = String.fromCharCode(...s).trim();
  }
  return { charging, isWorn, serial, raw: data };
}

// --- CONSOLE_LOGS (type 50) ------------------------------------------------
//
// Per whoomp.js:217-246: skip 7-byte header, drop trailing null, strip the
// 3-byte `0x34 0x00 0x01` segment markers, UTF-8 decode the rest.

export function parseConsoleLog(data) {
  if (data.length <= 8) return '';
  const sliced = data.subarray(7, data.length - 1);
  const cleaned = [];
  for (let i = 0; i < sliced.length; i++) {
    if (i + 2 < sliced.length &&
        sliced[i] === 0x34 && sliced[i + 1] === 0x00 && sliced[i + 2] === 0x01) {
      i += 2;
    } else {
      cleaned.push(sliced[i]);
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(cleaned));
  } catch {
    return '';
  }
}

// --- Top-level dispatcher --------------------------------------------------
//
// Takes a parsed WhoopPacket and returns a tagged decode object. Returns null
// if the packet type is not understood (caller can log/ignore).

export function decodePacket(pkt) {
  switch (pkt.type) {
    case PacketType.REALTIME_DATA:
      return parseRealtime(pkt.data);
    case PacketType.HISTORICAL_DATA:
      return parseHistorical(pkt.data);
    case PacketType.METADATA:
    case PacketType.PUFFIN_METADATA:
      return parseMetadata(pkt.cmd, pkt.data);
    case PacketType.EVENT:
    case PacketType.RELATIVE_PUFFIN_EVENTS:
    case PacketType.PUFFIN_EVENTS_FROM_STRAP:
      return parseEvent(pkt.cmd, pkt.data);
    case PacketType.COMMAND_RESPONSE:
      return { type: 'response', cmd: pkt.cmd, data: pkt.data };
    case PacketType.CONSOLE_LOGS:
      return { type: 'consoleLog', text: parseConsoleLog(pkt.data) };
    case PacketType.REALTIME_RAW_DATA:
      return { type: 'realtimeRaw', cmd: pkt.cmd, data: pkt.data };
    case PacketType.REALTIME_IMU_DATA_STREAM:
      return { type: 'imuRealtime', cmd: pkt.cmd, data: pkt.data };
    case PacketType.HISTORICAL_IMU_DATA_STREAM:
      return { type: 'imuHistorical', cmd: pkt.cmd, data: pkt.data };
    default:
      return { type: 'unknown', packetType: pkt.type, cmd: pkt.cmd, data: pkt.data };
  }
}
