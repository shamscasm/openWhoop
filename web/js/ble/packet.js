// Whoop 4.0 BLE packet framing + protocol enums.
// Canonical source: vendor/whoomp/packet.js (firmware-extracted enums).
//
// Every BLE notification or write on the custom service is a framed packet:
//
//   [SOF=0xAA] [len_lo] [len_hi] [crc8(len)] [type] [seq] [cmd] [data...] [crc32_le]
//
// `len` is little-endian uint16 = body_len + 4 (body covers type+seq+cmd+data,
// plus trailing 4-byte CRC32). The host distinguishes packet sources by the
// `type` byte (PacketType enum).

import { crc32Whoop as crc32, crc8, crc16Modbus } from './crc.js';

export const SOF = 0xaa;

// WHOOP 5.0 (Puffin) frame constants. The header gained a version flag and a
// 2-byte channel field, and swapped the 4.0 CRC-8 for CRC-16/Modbus:
//   [SOF=0xAA][0x01][len_lo][len_hi][0x00][0x01][crc16_lo][crc16_hi][payload…][crc32_le]
// `len` (LE u16) = paddedPayloadLen + 4; payload is zero-padded to a 4-byte
// boundary before the CRC-32 is taken.
export const V5_FLAG = 0x01;
export const V5_CHANNEL = Object.freeze([0x00, 0x01]);

// ---------------- Enums ----------------------------------------------------

export const PacketType = Object.freeze({
  COMMAND: 35,
  COMMAND_RESPONSE: 36,
  // 5.0 "Puffin" command path — mirror of 35/36 over the fd4b service.
  PUFFIN_COMMAND: 37,
  PUFFIN_COMMAND_RESPONSE: 38,
  REALTIME_DATA: 40,
  REALTIME_RAW_DATA: 43,
  HISTORICAL_DATA: 47,
  EVENT: 48,
  METADATA: 49,
  CONSOLE_LOGS: 50,
  REALTIME_IMU_DATA_STREAM: 51,
  HISTORICAL_IMU_DATA_STREAM: 52,
  // 5.0 additions. Events parse like 48; PUFFIN_METADATA marks history-end
  // exactly like 49 and MUST feed the same metadata queue.
  RELATIVE_PUFFIN_EVENTS: 53,
  PUFFIN_EVENTS_FROM_STRAP: 54,
  RELATIVE_BATTERY_PACK_CONSOLE_LOGS: 55,
  PUFFIN_METADATA: 56,
});

// Packet types that carry strap-side events, across both generations.
export const EVENT_TYPES = Object.freeze([
  PacketType.EVENT, PacketType.RELATIVE_PUFFIN_EVENTS, PacketType.PUFFIN_EVENTS_FROM_STRAP,
]);

// Packet types that carry history metadata (and thus drive the dump loop).
export const METADATA_TYPES = Object.freeze([
  PacketType.METADATA, PacketType.PUFFIN_METADATA,
]);

export const MetadataType = Object.freeze({
  HISTORY_START: 1,
  HISTORY_END: 2,
  HISTORY_COMPLETE: 3,
});

// Async events on CHAR_EVENT. Subset of these are surfaced to the UI.
export const EventNumber = Object.freeze({
  UNDEFINED: 0,
  ERROR: 1,
  CONSOLE_OUTPUT: 2,
  BATTERY_LEVEL: 3,
  SYSTEM_CONTROL: 4,
  EXTERNAL_5V_ON: 5,
  EXTERNAL_5V_OFF: 6,
  CHARGING_ON: 7,
  CHARGING_OFF: 8,
  WRIST_ON: 9,
  WRIST_OFF: 10,
  BLE_CONNECTION_UP: 11,
  BLE_CONNECTION_DOWN: 12,
  RTC_LOST: 13,
  DOUBLE_TAP: 14,
  BOOT: 15,
  SET_RTC: 16,
  TEMPERATURE_LEVEL: 17,
  PAIRING_MODE: 18,
  SERIAL_HEAD_CONNECTED: 19,
  SERIAL_HEAD_REMOVED: 20,
  BATTERY_PACK_CONNECTED: 21,
  BATTERY_PACK_REMOVED: 22,
  BLE_BONDED: 23,
  BLE_HR_PROFILE_ENABLED: 24,
  BLE_HR_PROFILE_DISABLED: 25,
  TRIM_ALL_DATA: 26,
  TRIM_ALL_DATA_ENDED: 27,
  FLASH_INIT_COMPLETE: 28,
  STRAP_CONDITION_REPORT: 29,
  BOOT_REPORT: 30,
  EXIT_VIRGIN_MODE: 31,
  CAPTOUCH_AUTOTHRESHOLD_ACTION: 32,
  BLE_REALTIME_HR_ON: 33,
  BLE_REALTIME_HR_OFF: 34,
  ACCELEROMETER_RESET: 35,
  AFE_RESET: 36,
  SHIP_MODE_ENABLED: 37,
  SHIP_MODE_DISABLED: 38,
  SHIP_MODE_BOOT: 39,
  CH1_SATURATION_DETECTED: 40,
  CH2_SATURATION_DETECTED: 41,
  ACCELEROMETER_SATURATION_DETECTED: 42,
  BLE_SYSTEM_RESET: 43,
  BLE_SYSTEM_ON: 44,
  BLE_SYSTEM_INITIALIZED: 45,
  RAW_DATA_COLLECTION_ON: 46,
  RAW_DATA_COLLECTION_OFF: 47,
  STRAP_DRIVEN_ALARM_SET: 56,
  STRAP_DRIVEN_ALARM_EXECUTED: 57,
  APP_DRIVEN_ALARM_EXECUTED: 58,
  STRAP_DRIVEN_ALARM_DISABLED: 59,
  HAPTICS_FIRED: 60,
  EXTENDED_BATTERY_INFORMATION: 63,
  HIGH_FREQ_SYNC_PROMPT: 96,
  HIGH_FREQ_SYNC_ENABLED: 97,
  HIGH_FREQ_SYNC_DISABLED: 98,
  HAPTICS_TERMINATED: 100,
});

// Reverse lookup: number → name. Useful for logging.
export const EventName = Object.freeze(
  Object.fromEntries(Object.entries(EventNumber).map(([k, v]) => [v, k]))
);

export const CommandNumber = Object.freeze({
  LINK_VALID: 1,
  GET_MAX_PROTOCOL_VERSION: 2,
  TOGGLE_REALTIME_HR: 3,
  REPORT_VERSION_INFO: 7,
  SET_CLOCK: 10,
  GET_CLOCK: 11,
  TOGGLE_GENERIC_HR_PROFILE: 14,
  TOGGLE_R7_DATA_COLLECTION: 16,
  RUN_HAPTIC_PATTERN_MAVERICK: 19,
  ABORT_HISTORICAL_TRANSMITS: 20,
  SEND_HISTORICAL_DATA: 22,
  HISTORICAL_DATA_RESULT: 23,
  FORCE_TRIM: 25,
  GET_BATTERY_LEVEL: 26,
  REBOOT_STRAP: 29,
  POWER_CYCLE_STRAP: 32,
  SET_READ_POINTER: 33,
  GET_DATA_RANGE: 34,
  GET_HELLO_HARVARD: 35,
  START_FIRMWARE_LOAD: 36,
  LOAD_FIRMWARE_DATA: 37,
  PROCESS_FIRMWARE_IMAGE: 38,
  SET_LED_DRIVE: 39,
  GET_LED_DRIVE: 40,
  SET_TIA_GAIN: 41,
  GET_TIA_GAIN: 42,
  SET_BIAS_OFFSET: 43,
  GET_BIAS_OFFSET: 44,
  ENTER_BLE_DFU: 45,
  SET_DP_TYPE: 52,
  FORCE_DP_TYPE: 53,
  SEND_R10_R11_REALTIME: 63,
  SET_ALARM_TIME: 66,
  GET_ALARM_TIME: 67,
  RUN_ALARM: 68,
  DISABLE_ALARM: 69,
  GET_ADVERTISING_NAME_HARVARD: 76,
  SET_ADVERTISING_NAME_HARVARD: 77,
  RUN_HAPTICS_PATTERN: 79,
  GET_ALL_HAPTICS_PATTERN: 80,
  START_RAW_DATA: 81,
  STOP_RAW_DATA: 82,
  VERIFY_FIRMWARE_IMAGE: 83,
  GET_BODY_LOCATION_AND_STATUS: 84,
  ENTER_HIGH_FREQ_SYNC: 96,
  EXIT_HIGH_FREQ_SYNC: 97,
  GET_EXTENDED_BATTERY_INFO: 98,
  RESET_FUEL_GAUGE: 99,
  CALIBRATE_CAPSENSE: 100,
  TOGGLE_IMU_MODE_HISTORICAL: 105,
  TOGGLE_IMU_MODE: 106,
  ENABLE_OPTICAL_DATA: 107,
  TOGGLE_OPTICAL_MODE: 108,
  // 5.0 persistent realtime-stream toggles, used by the physiology-capture
  // sequence to unlock R10/R11 optical + IMU streams.
  TOGGLE_PERSISTENT_R20: 153,
  TOGGLE_PERSISTENT_R21: 154,
  START_DEVICE_CONFIG_KEY_EXCHANGE: 115,
  SEND_NEXT_DEVICE_CONFIG: 116,
  START_FF_KEY_EXCHANGE: 117,
  SEND_NEXT_FF: 118,
  SET_DEVICE_CONFIG_VALUE: 119,
  SET_FF_VALUE: 120,
  GET_DEVICE_CONFIG_VALUE: 121,
  STOP_HAPTICS: 122,
  SELECT_WRIST: 123,
  TOGGLE_LABRADOR_DATA_GENERATION: 124,
  TOGGLE_LABRADOR_RAW_SAVE: 125,
  GET_FF_VALUE: 128,
  SET_RESEARCH_PACKET: 131,
  GET_RESEARCH_PACKET: 132,
  TOGGLE_LABRADOR_FILTERED: 139,
  SET_ADVERTISING_NAME: 140,
  GET_ADVERTISING_NAME: 141,
  START_FIRMWARE_LOAD_NEW: 142,
  LOAD_FIRMWARE_DATA_NEW: 143,
  PROCESS_FIRMWARE_IMAGE_NEW: 144,
  GET_HELLO: 145,
});

export const CommandName = Object.freeze(
  Object.fromEntries(Object.entries(CommandNumber).map(([k, v]) => [v, k]))
);

// ---------------- WhoopPacket: frame encode/decode -------------------------

export class WhoopPacket {
  constructor(type, seq, cmd, data = new Uint8Array()) {
    this.type = type;
    this.seq = seq;
    this.cmd = cmd;
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  /**
   * Parse a raw notification (or written frame) into a WhoopPacket.
   * Throws if SOF, CRC-8, or CRC-32 check fails.
   */
  static fromData(raw) {
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (data.length < 8) throw new Error(`Packet too short: ${data.length} bytes`);
    if (data[0] !== SOF) throw new Error(`Invalid SOF: 0x${data[0].toString(16)}`);

    const length = data[1] | (data[2] << 8);   // little-endian
    // The 4 CRC-32 bytes sit at data[length .. length+3], so the wire frame
    // must be at least length+4 bytes. Checking only `length > data.length`
    // let an exact-length (CRC-truncated) frame through, reading the CRC as
    // undefined→0 and silently failing every such packet.
    if (length < 8 || data.length < length + 4) {
      throw new Error(`Invalid packet length field: ${length} (raw ${data.length})`);
    }
    const lenBuf = new Uint8Array([data[1], data[2]]);
    if (crc8(lenBuf) !== data[3]) throw new Error('Header CRC-8 mismatch');

    // body = [type, seq, cmd, data...], crc32 sits in the last 4 bytes
    const body = data.subarray(4, length);
    const expectedCrc = data[length] | (data[length + 1] << 8) |
                        (data[length + 2] << 16) | (data[length + 3] << 24);
    if (crc32(body) !== (expectedCrc >>> 0)) throw new Error('Body CRC-32 mismatch');

    return new WhoopPacket(body[0], body[1], body[2], body.slice(3));
  }

  /** Return body bytes (type+seq+cmd+data), no SOF/len/crc framing. */
  bodyBytes() {
    const body = new Uint8Array(3 + this.data.length);
    body[0] = this.type & 0xff;
    body[1] = this.seq & 0xff;
    body[2] = this.cmd & 0xff;
    body.set(this.data, 3);
    return body;
  }

  /** Return fully-framed bytes ready to write to a GATT characteristic. */
  framed() {
    const body = this.bodyBytes();
    const length = body.length + 4;
    const lenBuf = new Uint8Array([length & 0xff, (length >> 8) & 0xff]);
    const c8 = crc8(lenBuf);
    const c32 = crc32(body);
    const out = new Uint8Array(4 + body.length + 4);
    out[0] = SOF;
    out[1] = lenBuf[0];
    out[2] = lenBuf[1];
    out[3] = c8;
    out.set(body, 4);
    const o = 4 + body.length;
    out[o] = c32 & 0xff;
    out[o + 1] = (c32 >>> 8) & 0xff;
    out[o + 2] = (c32 >>> 16) & 0xff;
    out[o + 3] = (c32 >>> 24) & 0xff;
    return out;
  }
}

/** Helper: build a host→strap COMMAND packet, framed. */
export function buildCommandFrame(cmd, payload = new Uint8Array(), seq = 0) {
  return new WhoopPacket(PacketType.COMMAND, seq, cmd, payload).framed();
}

// ---------------- WHOOP 5.0 (Puffin) frames --------------------------------

/**
 * Build a host→strap 5.0 command frame. Payload = [type=COMMAND(0x23), seq,
 * cmd, ...data], zero-padded to a 4-byte boundary, CRC-32 over the padded
 * payload, CRC-16/Modbus over the 6-byte header. The 5.0 difference from 4.0 is
 * the frame header, not the payload type byte — the command type is still
 * COMMAND(35), as proven by the CLIENT_HELLO vector below.
 *
 * buildV5CommandFrame(1, 0x91, [0x01]) reproduces the device CLIENT_HELLO frame
 * byte-for-byte — the canonical test vector.
 */
export function buildV5CommandFrame(seq, cmd, data = new Uint8Array()) {
  const raw = new Uint8Array(3 + data.length);
  raw[0] = PacketType.COMMAND;
  raw[1] = seq & 0xff;
  raw[2] = cmd & 0xff;
  raw.set(data, 3);

  const padLen = (4 - (raw.length % 4)) % 4;
  const payload = new Uint8Array(raw.length + padLen);
  payload.set(raw);

  const declaredLen = payload.length + 4;
  const header = new Uint8Array([SOF, V5_FLAG, declaredLen & 0xff, (declaredLen >> 8) & 0xff, V5_CHANNEL[0], V5_CHANNEL[1]]);
  const hdrCrc = crc16Modbus(header);
  const payCrc = crc32(payload);

  const frame = new Uint8Array(8 + payload.length + 4);
  frame.set(header);
  frame[6] = hdrCrc & 0xff;
  frame[7] = (hdrCrc >> 8) & 0xff;
  frame.set(payload, 8);
  const o = 8 + payload.length;
  frame[o]     = payCrc & 0xff;
  frame[o + 1] = (payCrc >>> 8) & 0xff;
  frame[o + 2] = (payCrc >>> 16) & 0xff;
  frame[o + 3] = (payCrc >>> 24) & 0xff;
  return frame;
}

/**
 * Split a raw 5.0 notification (which may concatenate several frames) into
 * individual frame byte-slices. Resyncs on the next 0xAA 0x01 if a frame looks
 * malformed.
 */
export function parseV5Frames(raw) {
  const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const frames = [];
  let i = 0;
  while (i + 8 <= data.length) {
    if (data[i] !== SOF || data[i + 1] !== V5_FLAG) { i++; continue; }
    const declaredLen = data[i + 2] | (data[i + 3] << 8);
    const total = 8 + declaredLen;          // header(8) + payload(declaredLen-4) + crc32(4)
    // Bad length or a frame that overruns the buffer: resync on the next
    // 0xAA 0x01 rather than abandoning every later frame in this notification.
    if (declaredLen < 4 || i + total > data.length) { i++; continue; }
    frames.push(data.subarray(i, i + total));
    i += total;
  }
  return frames;
}

/**
 * Validate one 5.0 frame and decode it into a WhoopPacket (type/seq/cmd/data),
 * so all downstream 4.0 decoders work unchanged. Returns null on CRC failure.
 */
export function v5FrameToPacket(frame) {
  const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (f.length < 12 || f[0] !== SOF || f[1] !== V5_FLAG) return null;
  const declaredLen = f[2] | (f[3] << 8);
  if (f.length < 8 + declaredLen) return null;
  if (crc16Modbus(f.subarray(0, 6)) !== (f[6] | (f[7] << 8))) return null;

  const payload = f.subarray(8, 8 + declaredLen - 4);
  const expectedCrc = (f[8 + declaredLen - 4] | (f[8 + declaredLen - 3] << 8) |
                       (f[8 + declaredLen - 2] << 16) | (f[8 + declaredLen - 1] << 24)) >>> 0;
  if (crc32(payload) !== expectedCrc) return null;
  if (payload.length < 3) return null;
  return new WhoopPacket(payload[0], payload[1], payload[2], payload.slice(3));
}

/** Decode a raw 5.0 notification into zero or more valid WhoopPackets. */
export function decodeV5(raw) {
  const out = [];
  for (const frame of parseV5Frames(raw)) {
    const pkt = v5FrameToPacket(frame);
    if (pkt) out.push(pkt);
  }
  return out;
}
