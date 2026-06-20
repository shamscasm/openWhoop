import { describe, it, expect } from 'vitest';
import {
  WhoopPacket, PacketType, EventNumber, MetadataType,
} from '../../../web/js/ble/packet.js';
import {
  parseRealtime, parseHistorical, parseMetadata, parseEvent,
  parseBatteryResponse, parseClockResponse, parseHelloResponse,
  parseConsoleLog, decodePacket,
} from '../../../web/js/ble/parsers.js';

function pad(arr, size) {
  const out = new Uint8Array(size);
  out.set(arr, 0);
  return out;
}

describe('parseRealtime', () => {
  it('decodes HR at data[5] (whoomp canonical offset)', () => {
    // body data: [_, _, _, _, _, HR=72, rrnum=1, rr_lo, rr_hi, ...]
    const data = pad([0, 0, 0, 0, 0, 72, 1, 833 & 0xff, (833 >> 8) & 0xff], 32);
    const out = parseRealtime(data);
    expect(out.heartRateBpm).toBe(72);
    expect(out.rrIntervalsMs).toEqual([833]);
  });

  it('returns null HR for out-of-range values', () => {
    const data = pad([0, 0, 0, 0, 0, 5, 0], 32);
    const out = parseRealtime(data);
    expect(out.heartRateBpm).toBeNull();
  });

  it('reads up to 4 RR intervals', () => {
    const rrs = [800, 810, 820, 830];
    const arr = [0, 0, 0, 0, 0, 70, 4];
    for (const rr of rrs) { arr.push(rr & 0xff); arr.push((rr >> 8) & 0xff); }
    const out = parseRealtime(pad(arr, 64));
    expect(out.rrIntervalsMs).toEqual(rrs);
  });

  it('filters out-of-range RR intervals', () => {
    const arr = [0, 0, 0, 0, 0, 70, 2, 100, 0, 800 & 0xff, (800 >> 8) & 0xff];
    const out = parseRealtime(pad(arr, 32));
    expect(out.rrIntervalsMs).toEqual([800]);
  });
});

describe('parseHistorical', () => {
  it('decodes unix + HR + RR per whoomp parser.py offsets', () => {
    const data = new Uint8Array(32);
    // bytes 0..3 unknown header, 4..8 unix, 8..10 subsec, 10..14 flashIdx,
    // 14 HR, 15 rrnum, 16.. RR.
    const unix = 0x67c4ac01;
    data[4] = unix & 0xff;
    data[5] = (unix >> 8) & 0xff;
    data[6] = (unix >> 16) & 0xff;
    data[7] = (unix >> 24) & 0xff;
    data[8] = 0xa0; data[9] = 0x06;          // subsec
    data[10] = 0x32; data[11] = 0x00; data[12] = 0x00; data[13] = 0x00; // flashIdx=50
    data[14] = 65;                            // HR
    data[15] = 2;                             // rrnum
    data[16] = 800 & 0xff; data[17] = (800 >> 8) & 0xff;
    data[18] = 810 & 0xff; data[19] = (810 >> 8) & 0xff;

    const out = parseHistorical(data);
    expect(out.unix).toBe(unix);
    expect(out.subsec).toBe(0x06a0);
    expect(out.flashIndex).toBe(50);
    expect(out.heartRateBpm).toBe(65);
    expect(out.rrIntervalsMs).toEqual([800, 810]);
  });

  it('decodes V12/V24 DSP raw fields and respiratory rate scale', () => {
    const data = new Uint8Array(85);
    const unix = 0x67c4ac01;
    data[4] = unix & 0xff;
    data[5] = (unix >> 8) & 0xff;
    data[6] = (unix >> 16) & 0xff;
    data[7] = (unix >> 24) & 0xff;
    data[14] = 65;
    data[61] = 713 & 0xff; data[62] = (713 >> 8) & 0xff;
    data[63] = 764 & 0xff; data[64] = (764 >> 8) & 0xff;
    data[65] = 1604 & 0xff; data[66] = (1604 >> 8) & 0xff;
    data[73] = 2817 & 0xff; data[74] = (2817 >> 8) & 0xff;

    const out = parseHistorical(data, 12);
    expect(out.version).toBe(12);
    expect(out._dataLen).toBe(85);
    expect(out.spo2Red).toBe(713);
    expect(out.spo2Ir).toBe(764);
    expect(out.skinTempRaw).toBe(1604);
    expect(out.skinTempC).toBeCloseTo(37.741, 3);
    expect(out.respRateRaw).toBe(2817);
    expect(out.respRateRpm).toBeCloseTo(14.085, 3);
  });
});

describe('parseMetadata', () => {
  it('extracts trim from HISTORY_END (cmd 2)', () => {
    // example from agent research: trim=0x8b9e at offset 10
    const data = new Uint8Array(14);
    // unix
    data[0] = 0xc9; data[1] = 0xc4; data[2] = 0x7a; data[3] = 0x67;
    // subsec
    data[4] = 0xa0; data[5] = 0x06;
    // unk
    data[6] = 0x32; data[7] = 0x00; data[8] = 0x00; data[9] = 0x00;
    // trim
    data[10] = 0x9e; data[11] = 0x8b; data[12] = 0x00; data[13] = 0x00;

    const out = parseMetadata(MetadataType.HISTORY_END, data);
    expect(out.kind).toBe('historyEnd');
    expect(out.trim).toBe(0x8b9e);
  });

  it('flags HISTORY_COMPLETE', () => {
    const out = parseMetadata(MetadataType.HISTORY_COMPLETE, new Uint8Array(0));
    expect(out.kind).toBe('historyComplete');
    expect(out.trim).toBeUndefined();
  });
});

describe('parseEvent', () => {
  it('decodes WRIST_ON with timestamp', () => {
    const data = new Uint8Array([0x09, 0x01, 0x02, 0x03, 0x04]); // u32 at offset 1
    const out = parseEvent(EventNumber.WRIST_ON, data);
    expect(out.name).toBe('WRIST_ON');
    expect(out.semantic).toBe('wristOn');
    expect(out.unix).toBe(0x04030201);
  });

  it('decodes CHARGING_OFF', () => {
    const out = parseEvent(EventNumber.CHARGING_OFF, new Uint8Array([0, 0, 0, 0, 0]));
    expect(out.semantic).toBe('chargingOff');
  });

  it('decodes DOUBLE_TAP', () => {
    const out = parseEvent(EventNumber.DOUBLE_TAP, new Uint8Array([0, 0, 0, 0, 0]));
    expect(out.semantic).toBe('doubleTap');
  });

  it('preserves the event name for unknown codes', () => {
    const out = parseEvent(255, new Uint8Array([0, 0, 0, 0, 0]));
    expect(out.name).toBe('UNKNOWN_255');
  });

  it('tags TEMPERATURE_LEVEL as a candidate without decoding a temperature', () => {
    const body = new Uint8Array([0, 1, 2, 3, 4, 0xab, 0xcd]);
    const out = parseEvent(EventNumber.TEMPERATURE_LEVEL, body);
    expect(out.name).toBe('TEMPERATURE_LEVEL');
    expect(out.semantic).toBe('temperatureLevel');
    // Raw bytes are passed through for offline analysis...
    expect(out.raw).toBe(body);
    // ...but no decoded value is fabricated — not a temperature, and not even
    // the generic event timestamp (its offset is unverified for this event).
    expect(out.temperatureC).toBeUndefined();
    expect(out.celsius).toBeUndefined();
    expect(out.unix).toBeUndefined();
  });

  it('tags STRAP_CONDITION_REPORT and passes raw bytes through, no value decode', () => {
    const body = new Uint8Array([0, 9, 8, 7, 6]);
    const out = parseEvent(EventNumber.STRAP_CONDITION_REPORT, body);
    expect(out.semantic).toBe('strapConditionReport');
    expect(out.raw).toBe(body);
    expect(out.unix).toBeUndefined();
  });
});

describe('parseBatteryResponse', () => {
  it('decodes battery%×10 at offset 2', () => {
    const data = new Uint8Array([0, 0, 0xe8, 0x03]); // 0x03e8 = 1000 → 100.0%
    expect(parseBatteryResponse(data)).toBe(100);
  });
});

describe('parseClockResponse', () => {
  it('decodes u32 LE at offset 2', () => {
    const unix = 0x67c4ac01;
    const data = new Uint8Array([0, 0, unix & 0xff, (unix >> 8) & 0xff, (unix >> 16) & 0xff, (unix >> 24) & 0xff]);
    expect(parseClockResponse(data)).toBe(unix);
  });
});

describe('parseHelloResponse', () => {
  it('extracts charging + wrist flags', () => {
    const data = new Uint8Array(130);
    data[7] = 1;    // charging
    data[116] = 0;  // not worn
    const out = parseHelloResponse(data);
    expect(out.charging).toBe(true);
    expect(out.isWorn).toBe(false);
  });

  it('returns partial for short responses', () => {
    const out = parseHelloResponse(new Uint8Array(50));
    expect(out.partial).toBe(true);
  });
});

describe('parseConsoleLog', () => {
  it('strips header and decodes UTF-8 text', () => {
    const text = 'hello strap';
    const data = new Uint8Array(8 + text.length);
    for (let i = 0; i < text.length; i++) data[7 + i] = text.charCodeAt(i);
    expect(parseConsoleLog(data)).toBe(text);
  });

  it('removes the 0x34 0x00 0x01 segment markers', () => {
    const text = 'abc';
    const bytes = [0,0,0,0,0,0,0, 0x61, 0x34, 0x00, 0x01, 0x62, 0x63, 0];
    expect(parseConsoleLog(new Uint8Array(bytes))).toBe(text);
  });
});

describe('decodePacket dispatcher', () => {
  it('dispatches REALTIME_DATA', () => {
    const data = pad([0, 0, 0, 0, 0, 80, 0], 32);
    const pkt = new WhoopPacket(PacketType.REALTIME_DATA, 0, 0, data);
    const out = decodePacket(pkt);
    expect(out.type).toBe('realtime');
    expect(out.heartRateBpm).toBe(80);
  });

  it('dispatches METADATA', () => {
    const pkt = new WhoopPacket(PacketType.METADATA, 0, MetadataType.HISTORY_COMPLETE, new Uint8Array(0));
    const out = decodePacket(pkt);
    expect(out.type).toBe('metadata');
    expect(out.kind).toBe('historyComplete');
  });

  it('dispatches EVENT', () => {
    const pkt = new WhoopPacket(PacketType.EVENT, 0, EventNumber.DOUBLE_TAP, new Uint8Array([0, 0, 0, 0, 0]));
    const out = decodePacket(pkt);
    expect(out.type).toBe('event');
    expect(out.semantic).toBe('doubleTap');
  });

  it('returns unknown for unrecognized PacketTypes', () => {
    const pkt = new WhoopPacket(99, 0, 0, new Uint8Array(0));
    const out = decodePacket(pkt);
    expect(out.type).toBe('unknown');
  });
});
