import { describe, it, expect } from 'vitest';
import { crc32Whoop, crc8, crc16Modbus, verifyCrc } from '../../../web/js/ble/crc.js';

describe('crc32Whoop', () => {
  it('matches the empty-input known value', () => {
    expect(crc32Whoop(new Uint8Array())).toBe(0);
  });

  it('returns a uint32 for a non-empty buffer', () => {
    const data = new Uint8Array([35, 0, 7, 0]);
    const crc = crc32Whoop(data);
    expect(crc).toBe(0xdc82490b);
  });

  it('verifyCrc returns true for matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, crc32Whoop(data))).toBe(true);
  });

  it('verifyCrc returns false for non-matching CRC', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyCrc(data, 0xdeadbeef)).toBe(false);
  });
});

describe('crc8', () => {
  it('computes correct crc8 for length bytes', () => {
    const lenBuf = new Uint8Array([0x08, 0x00]);
    expect(crc8(lenBuf)).toBe(0xa8);
  });
});

describe('crc16Modbus (Whoop 5.0 header)', () => {
  it('matches the known "123456789" Modbus check value 0x4B37', () => {
    const ascii = new Uint8Array([...'123456789'].map(c => c.charCodeAt(0)));
    expect(crc16Modbus(ascii)).toBe(0x4b37);
  });

  it('matches the device CLIENT_HELLO header → 0x71e6 (LE e6 71)', () => {
    const header = new Uint8Array([0xaa, 0x01, 0x08, 0x00, 0x00, 0x01]);
    const crc = crc16Modbus(header);
    expect(crc).toBe(0x71e6);
    expect(crc & 0xff).toBe(0xe6);
    expect((crc >> 8) & 0xff).toBe(0x71);
  });
});
