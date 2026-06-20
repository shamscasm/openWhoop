import struct
import pytest
from whoop_reader.parser import parse_realtime_packet
from whoop_reader.protocol import crc32_whoop

def test_parse_realtime_packet_28_bytes():
    # Construct a valid 28-byte packet
    pkt = bytearray(28)
    pkt[0] = 0xAA
    pkt[1] = 24
    pkt[2] = 0
    pkt[3] = 0xFF # crc8
    
    # Body (20 bytes)
    pkt[4] = 40   # Type = REALTIME_DATA
    pkt[5] = 2    # Seq = 2
    pkt[6] = 0x8D # Cmd
    # Payload starts at index 7. payload[5] is index 12.
    pkt[12] = 95  # Heart rate = 95
    
    # Calculate CRC32 over the first 24 bytes
    body = pkt[:24]
    crc = crc32_whoop(body)
    struct.pack_into("<I", pkt, 24, crc)
    
    parsed = parse_realtime_packet(pkt)
    assert parsed.sequence == 2
    assert parsed.heart_rate_bpm == 95.0
    assert parsed.rr_interval_ms is None
    assert parsed.crc_valid is True

def test_parse_realtime_packet_96_bytes():
    # Construct a valid 96-byte packet
    pkt = bytearray(96)
    pkt[0] = 1 # sequence
    # heart rate at raw[1:3] (BPM * 100, uint16 LE)
    struct.pack_into("<H", pkt, 1, 7200) # 72 BPM
    struct.pack_into("<H", pkt, 3, 833)  # 833 ms RR
    pkt[5] = 98 # SpO2
    pkt[6] = 58 # tempByte (58 - 25 = 33 C)
    
    body = pkt[:92]
    crc = crc32_whoop(body)
    struct.pack_into("<I", pkt, 92, crc)
    
    parsed = parse_realtime_packet(pkt)
    assert parsed.sequence == 1
    assert parsed.heart_rate_bpm == 72.0
    assert parsed.rr_interval_ms == 833
    assert parsed.spo2_pct == 98
    assert parsed.skin_temp_c == 33.0
    assert parsed.crc_valid is True

def test_parse_realtime_packet_invalid_length():
    with pytest.raises(ValueError):
        parse_realtime_packet(bytes(27))
    with pytest.raises(ValueError):
        parse_realtime_packet(bytes(95))
