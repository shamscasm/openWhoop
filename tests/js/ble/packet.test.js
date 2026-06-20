import { describe, it, expect } from 'vitest';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber, MetadataType,
  buildCommandFrame, SOF,
  buildV5CommandFrame, parseV5Frames, v5FrameToPacket, decodeV5,
} from '../../../web/js/ble/packet.js';
import { crc32Whoop, crc8 } from '../../../web/js/ble/crc.js';

function buildFrame(type, seq, cmd, payload = new Uint8Array()) {
  return new WhoopPacket(type, seq, cmd, payload).framed();
}

describe('WhoopPacket framing', () => {
  it('round-trips through framed() + fromData()', () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const pkt = new WhoopPacket(PacketType.COMMAND, 7, CommandNumber.GET_BATTERY_LEVEL, payload);
    const frame = pkt.framed();

    expect(frame[0]).toBe(SOF);
    const parsed = WhoopPacket.fromData(frame);
    expect(parsed.type).toBe(PacketType.COMMAND);
    expect(parsed.seq).toBe(7);
    expect(parsed.cmd).toBe(CommandNumber.GET_BATTERY_LEVEL);
    expect(Array.from(parsed.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('length field is little-endian body_len + 4', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    // body = type+seq+cmd+payload = 4 bytes; len = 4 + 4(crc32) = 8
    expect(frame[1]).toBe(0x08);
    expect(frame[2]).toBe(0x00);
  });

  it('crc8 of length bytes matches', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    expect(frame[3]).toBe(crc8(new Uint8Array([frame[1], frame[2]])));
  });

  it('trailing crc32 matches over body', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    const length = frame[1] | (frame[2] << 8);
    const body = frame.slice(4, length);
    const crc = frame[length] | (frame[length + 1] << 8) |
                (frame[length + 2] << 16) | (frame[length + 3] << 24);
    expect(crc >>> 0).toBe(crc32Whoop(body));
  });

  it('rejects bad SOF', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR);
    frame[0] = 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/SOF/);
  });

  it('rejects bad crc8', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    frame[3] ^= 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/CRC-8/);
  });

  it('rejects bad crc32', () => {
    const frame = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    frame[frame.length - 1] ^= 0xff;
    expect(() => WhoopPacket.fromData(frame)).toThrow(/CRC-32/);
  });

  it('rejects too-short frames', () => {
    expect(() => WhoopPacket.fromData(new Uint8Array([0xaa, 0, 0]))).toThrow();
  });

  it('rejects frames whose CRC-32 bytes are truncated (off-by-4 guard)', () => {
    const full = buildFrame(PacketType.COMMAND, 0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    // length+3 bytes: the 4th CRC byte runs off the end. Must reject, not read
    // undefined→0 and then spuriously fail the CRC-32 comparison on valid data.
    expect(() => WhoopPacket.fromData(full.slice(0, full.length - 1))).toThrow(/length/);
    // Exactly `length` bytes: the whole CRC-32 is missing.
    const length = full[1] | (full[2] << 8);
    expect(() => WhoopPacket.fromData(full.slice(0, length))).toThrow(/length/);
  });
});

describe('buildCommandFrame helper', () => {
  it('is equivalent to constructing a COMMAND packet', () => {
    const a = buildCommandFrame(CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00]), 5);
    const b = new WhoopPacket(PacketType.COMMAND, 5, CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00])).framed();
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('WHOOP 5.0 (Puffin) framing', () => {
  // The exact CLIENT_HELLO frame the strap expects. If buildV5CommandFrame
  // diverges from this, the 5.0 handshake silently fails.
  const CLIENT_HELLO = [
    0xaa, 0x01, 0x08, 0x00, 0x00, 0x01, 0xe6, 0x71,
    0x23, 0x01, 0x91, 0x01, 0x36, 0x3e, 0x5c, 0x8d,
  ];

  it('buildV5CommandFrame reproduces the canonical CLIENT_HELLO byte-for-byte', () => {
    const frame = buildV5CommandFrame(1, 0x91, new Uint8Array([0x01]));
    expect(Array.from(frame)).toEqual(CLIENT_HELLO);
  });

  it('frame layout: SOF, flag, LE length = paddedPayload+4, channel bytes', () => {
    const frame = buildV5CommandFrame(0, CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
    // payload [35, 0, 3, 1] is already 4-byte aligned → declaredLen = 4 + 4 = 8
    expect(frame[0]).toBe(SOF);
    expect(frame[1]).toBe(0x01);
    expect(frame[2]).toBe(0x08);
    expect(frame[3]).toBe(0x00);
    expect(frame[4]).toBe(0x00);
    expect(frame[5]).toBe(0x01);
  });

  it('zero-pads the payload to a 4-byte boundary', () => {
    // payload [37, seq, cmd] = 3 bytes → 1 byte pad → 4; declaredLen = 8
    const frame = buildV5CommandFrame(2, 0x07, new Uint8Array());
    expect(frame[2]).toBe(0x08);
    expect(frame.length).toBe(8 + 4 + 4);
  });

  it('round-trips build → v5FrameToPacket', () => {
    const frame = buildV5CommandFrame(9, CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0xab, 0xcd]));
    const pkt = v5FrameToPacket(frame);
    expect(pkt.type).toBe(PacketType.COMMAND);
    expect(pkt.seq).toBe(9);
    expect(pkt.cmd).toBe(CommandNumber.GET_BATTERY_LEVEL);
    // data carries the two real bytes plus zero padding to the 4-byte boundary
    expect(Array.from(pkt.data.slice(0, 2))).toEqual([0xab, 0xcd]);
  });

  it('parseV5Frames splits a notification carrying several concatenated frames', () => {
    const a = buildV5CommandFrame(0, 0x03, new Uint8Array([0x01]));
    const b = buildV5CommandFrame(1, 0x1a, new Uint8Array([0x00]));
    const joined = new Uint8Array([...a, ...b]);
    const frames = parseV5Frames(joined);
    expect(frames.length).toBe(2);
    expect(decodeV5(joined).map(p => p.cmd)).toEqual([0x03, 0x1a]);
  });

  it('parseV5Frames resyncs past a malformed length and still finds the valid frame', () => {
    // Leading [AA 01 00 00] has declaredLen 0 (<4) — must resync byte-by-byte,
    // not abandon the rest of the notification.
    const good = buildV5CommandFrame(3, 0x03, new Uint8Array([0x01]));
    const noisy = new Uint8Array([0xaa, 0x01, 0x00, 0x00, ...good]);
    const decoded = decodeV5(noisy);
    expect(decoded.length).toBe(1);
    expect(decoded[0].cmd).toBe(0x03);
  });

  it('v5FrameToPacket rejects a header CRC-16 mismatch', () => {
    const frame = buildV5CommandFrame(1, 0x91, new Uint8Array([0x01]));
    frame[6] ^= 0xff;
    expect(v5FrameToPacket(frame)).toBeNull();
  });

  it('v5FrameToPacket rejects a payload CRC-32 mismatch', () => {
    const frame = buildV5CommandFrame(1, 0x91, new Uint8Array([0x01]));
    frame[frame.length - 1] ^= 0xff;
    expect(v5FrameToPacket(frame)).toBeNull();
  });

  it('decodeV5 drops corrupt frames but keeps valid ones', () => {
    const good = buildV5CommandFrame(0, 0x03, new Uint8Array([0x01]));
    const bad = buildV5CommandFrame(1, 0x1a, new Uint8Array([0x00]));
    bad[8] ^= 0xff;  // corrupt payload → CRC32 fails
    const decoded = decodeV5(new Uint8Array([...good, ...bad]));
    expect(decoded.length).toBe(1);
    expect(decoded[0].cmd).toBe(0x03);
  });
});

describe('protocol enums', () => {
  it('PacketType matches canonical values', () => {
    expect(PacketType.COMMAND).toBe(35);
    expect(PacketType.REALTIME_DATA).toBe(40);
    expect(PacketType.HISTORICAL_DATA).toBe(47);
    expect(PacketType.EVENT).toBe(48);
    expect(PacketType.METADATA).toBe(49);
  });

  it('PacketType includes the 5.0 Puffin additions', () => {
    expect(PacketType.PUFFIN_COMMAND).toBe(37);
    expect(PacketType.PUFFIN_COMMAND_RESPONSE).toBe(38);
    expect(PacketType.RELATIVE_PUFFIN_EVENTS).toBe(53);
    expect(PacketType.PUFFIN_EVENTS_FROM_STRAP).toBe(54);
    expect(PacketType.PUFFIN_METADATA).toBe(56);
  });

  it('MetadataType matches canonical values', () => {
    expect(MetadataType.HISTORY_START).toBe(1);
    expect(MetadataType.HISTORY_END).toBe(2);
    expect(MetadataType.HISTORY_COMPLETE).toBe(3);
  });

  it('CommandNumber covers the critical commands', () => {
    expect(CommandNumber.TOGGLE_REALTIME_HR).toBe(3);
    expect(CommandNumber.GET_BATTERY_LEVEL).toBe(26);
    expect(CommandNumber.SEND_HISTORICAL_DATA).toBe(22);
    expect(CommandNumber.HISTORICAL_DATA_RESULT).toBe(23);
    expect(CommandNumber.GET_DATA_RANGE).toBe(34);
    expect(CommandNumber.SET_CLOCK).toBe(10);
    expect(CommandNumber.GET_CLOCK).toBe(11);
    expect(CommandNumber.GET_HELLO_HARVARD).toBe(35);
    expect(CommandNumber.ENTER_HIGH_FREQ_SYNC).toBe(96);
  });

  it('EventNumber covers events we wire to the UI', () => {
    expect(EventNumber.WRIST_ON).toBe(9);
    expect(EventNumber.WRIST_OFF).toBe(10);
    expect(EventNumber.CHARGING_ON).toBe(7);
    expect(EventNumber.CHARGING_OFF).toBe(8);
    expect(EventNumber.DOUBLE_TAP).toBe(14);
    expect(EventNumber.RTC_LOST).toBe(13);
    expect(EventNumber.HIGH_FREQ_SYNC_PROMPT).toBe(96);
  });
});
