# Whoop 4.0 BLE Protocol Reference

Permanent reference for the custom GATT service exposed by the Whoop 4.0
strap. This is the protocol that `whoof` (the JS web client under
`web/js/ble/`) speaks, and the protocol implemented — to varying degrees —
by the two vendored reverse-engineering projects under `vendor/`.

## 1. Introduction

### 1.1 Scope

This document covers:

- The custom GATT service `61080000-…` and its five characteristics.
- The packet framing (SOF, length, CRC-8, body, CRC-32).
- The full set of firmware-extracted enums: 10 `PacketType` values,
  73 `CommandNumber` values, 100+ `EventNumber` values, and 3
  `MetadataType` values.
- The body decode for every packet type we currently understand
  (realtime, historical, metadata, event, common command responses,
  console logs).
- The historical-download state machine (trim/ACK protocol).
- Known unknowns: bytes 18..91 of the realtime packet, the IMU stream
  formats, the diagnostic (Memfault) channel, and several command
  payload/response layouts.

### 1.2 What the service looks like

The strap exposes one custom primary service with five characteristics.
All packetised traffic flows over four of them; the fifth carries
Memfault diagnostics in an opaque format.

| UUID (last 4 hex digits aliased) | Direction | Properties | Purpose |
|----------------------------------|-----------|------------|---------|
| `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` | — | service | Primary service container |
| `61080002-…` (`CHAR_COMMAND`) | host → strap | write | Command frames (`PacketType.COMMAND`) |
| `61080003-…` (`CHAR_RESPONSE`) | strap → host | notify | Command responses (`PacketType.COMMAND_RESPONSE`) |
| `61080004-…` (`CHAR_EVENT`) | strap → host | notify | Asynchronous events (`PacketType.EVENT`) |
| `61080005-…` (`CHAR_DATA`) | strap → host | notify | Realtime/historical/metadata/console-log/IMU streams |
| `61080007-…` (`CHAR_DIAG`) | strap → host | notify | Memfault diagnostic blobs (opaque) |

(Defined in `/Users/helios/claude/whoop/web/js/ble/uuids.js`,
`/Users/helios/claude/whoop/vendor/whoomp/whoomp.js:6-10`,
`/Users/helios/claude/whoop/vendor/whoomp/scripts/whoop.py:5-10`, and
`/Users/helios/claude/whoop/vendor/whoop-reader/whoop_reader/protocol.py:20-47`.)

Note: `vendor/whoop-reader` mislabels `CHAR_EVENT` (`…0004`) as a
diagnostics channel and `CHAR_DATA` (`…0005`) as a 96-byte realtime
channel. Both whoomp and our implementation treat `…0004` as the event
channel and `…0005` as the multiplexed data channel, which matches the
firmware-extracted packet-type byte (the strap puts `PacketType.EVENT`
frames on `…0004` and `PacketType.REALTIME_DATA` /
`PacketType.HISTORICAL_DATA` / `PacketType.METADATA` /
`PacketType.CONSOLE_LOGS` / IMU frames on `…0005`).

### 1.3 Who to trust when sources disagree

Three families of sources contribute to this document. Trust ordering,
in descending priority:

1. **`vendor/whoomp/packet.js` + `vendor/whoomp/scripts/packet.py`** —
   the canonical source for enum names and numeric values. These are
   extracted from disassembled firmware/Android-app strings (see
   `vendor/whoomp/README.md`). Treat as authoritative for the *list*
   of commands/events/packet-types that exist.
2. **`vendor/whoomp/whoomp.js` and `scripts/whoop.py`** — the live
   protocol exerciser. Anything actually used over the air there
   (TOGGLE_REALTIME_HR, SEND_HISTORICAL_DATA, HISTORICAL_DATA_RESULT,
   GET_BATTERY_LEVEL, GET_CLOCK, SET_CLOCK, GET_HELLO_HARVARD,
   REPORT_VERSION_INFO, RUN_HAPTICS_PATTERN, RUN_ALARM, REBOOT_STRAP,
   START/STOP_RAW_DATA, TOGGLE_GENERIC_HR_PROFILE, FORCE_TRIM) is
   considered tested. Body-decode offsets here are authoritative.
3. **`vendor/whoop-reader/whoop_reader/parser.py` and `protocol.py`** —
   a secondary, partly-incorrect re-derivation. Useful as cross-check
   for the GATT layout, but **wrong** about:
   - The realtime body offsets — its 96-byte parser computes
     `heart_rate_bpm` from bytes 1–2 as `uint16 / 100`, but the
     firmware-extracted source puts heart rate at body byte 5 as a
     plain `uint8` (`vendor/whoomp/whoomp.js:201`,
     `vendor/whoomp/scripts/parser.py:142`). It also speculates
     SpO2/skin-temp/PPG-amplitude/ambient-light/PPG-quality layouts
     that have no firmware backing.
   - The command-frame format. `protocol.py:159-163` documents
     `[0xAA] [CMD] [LENGTH_LO] [LENGTH_HI] [PAYLOAD…] [CRC32_LE]`,
     which is missing the `type`, `seq`, and CRC-8 fields. Its own
     `build_command()` is correct — the doc string is stale.
   - The CRC-32 spec. `vendor/whoop-reader/README.md:151-156` claims
     a non-zlib variant with final XOR `0xF43F44AC`; the actual
     implementation in `protocol.py:124` is plain `zlib.crc32`, which
     matches whoomp and our `crc32Whoop()`.

When two sources contradict each other, prefer (1) and (2). Where this
document marks something as "unknown" or "speculative", that's because
nothing on this trust hierarchy has confirmed it.

### 1.4 Endianness and word sizes

All multi-byte integers on the wire are **little-endian** unless stated
otherwise. Word sizes:

- `u8` — 1 byte
- `u16le` — 2 bytes, LE
- `u32le` — 4 bytes, LE
- `i16le` — 2 bytes, LE, two's-complement signed

The body decoders in `web/js/ble/parsers.js` ship LE helpers as
`u16le`, `i16le`, `u32le`.

## 2. Frame format

Every BLE notification on a data/event/response characteristic, and
every write to the command characteristic, is one framed packet:

```
+------+-------------+-------+-------------------------------+----------+
| SOF  | length (LE) | crc8  |   body (length-4 bytes)       | crc32 LE |
| 0xAA |   u16       |  u8   |  type | seq | cmd | data...   |   u32    |
+------+-------------+-------+-------------------------------+----------+
  1B        2B          1B            ... length-4 bytes ...     4B
```

Total frame length on the wire is `4 + length` bytes. The `length`
field counts the body (`type | seq | cmd | data…`) **plus** the
trailing 4-byte CRC-32 — i.e. `length = bodyLen + 4`, where `bodyLen >= 3`
(the three header bytes are required). Minimum legal frame size is
therefore 8 bytes (`length = 8`, body is exactly `type|seq|cmd`, data
is empty).

Layout:

| Offset | Field | Type | Notes |
|-------:|-------|------|-------|
| 0 | SOF | `u8` | Always `0xAA`. Frames are not separated by anything else — one frame per notification. |
| 1 | length | `u16le` | `bodyLen + 4`. Frame is `4 + length` bytes total. |
| 3 | crc8 | `u8` | CRC-8 of the two length bytes (see §2.1). Header integrity. |
| 4 | type | `u8` | `PacketType` (see §3). |
| 5 | seq | `u8` | Sequence number set by sender. Host increments per command; strap echoes its own counters. Wraps mod 256. |
| 6 | cmd | `u8` | Interpretation depends on `type`: `CommandNumber` for `COMMAND`/`COMMAND_RESPONSE`, `EventNumber` for `EVENT`, `MetadataType` for `METADATA`, unused/repurposed for the streaming types. |
| 7..(length-1) | data | bytes | Type/cmd-specific payload. May be empty. |
| length | crc32 | `u32le` | CRC-32 of `body = data[4:length]` (i.e. `type|seq|cmd|data`). |

Reference implementations:

- `WhoopPacket.framed()` / `WhoopPacket.fromData()` in
  `/Users/helios/claude/whoop/web/js/ble/packet.js:199-249`.
- `WhoopPacket.framed_packet()` / `from_data()` in
  `/Users/helios/claude/whoop/vendor/whoomp/scripts/packet.py:291-325`.
- `WhoopPacket.framedPacket()` / `fromData()` in
  `/Users/helios/claude/whoop/vendor/whoomp/packet.js:178-299`.

### 2.1 CRC-8 (length field)

Standard CRC-8, polynomial `0x07`, initial value `0x00`, no
reflection, no final XOR. Computed over the two length bytes
(`[length_lo, length_hi]`).

The bit-by-bit reference in `vendor/whoomp/packet.js:238-252`:

```js
for (let byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
        if (crc & 0x80) crc = (crc << 1) ^ 0x07;
        else            crc <<= 1;
    }
}
return crc & 0xFF;
```

A precomputed 256-entry lookup table for this exact polynomial lives in
`vendor/whoomp/scripts/packet.py:157-174`,
`vendor/whoop-reader/whoop_reader/protocol.py:94-111`, and
`/Users/helios/claude/whoop/web/js/ble/crc.js:15-32`. All three tables
are byte-for-byte identical.

### 2.2 CRC-32 (body)

Standard zlib / Ethernet CRC-32:

- Polynomial (reflected): `0xEDB88320`
- Initial value: `0xFFFFFFFF`
- Input/output reflected: yes (implicit in the reflected polynomial form)
- Final XOR: `0xFFFFFFFF` (i.e. bitwise NOT at the end)

Computed over the body bytes (`type | seq | cmd | data`).

Reference in `web/js/ble/crc.js:34-40`:

```js
let crc = 0xFFFFFFFF;
for (const byte of data) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xFF];
}
return (crc ^ 0xFFFFFFFF) >>> 0;
```

This is identical to Python's `zlib.crc32(body) & 0xFFFFFFFF`
(`vendor/whoomp/scripts/packet.py:303`,
`vendor/whoop-reader/whoop_reader/protocol.py:124-125`).

Important: the `vendor/whoop-reader/README.md` description that claims
a custom polynomial and final XOR `0xF43F44AC` is wrong — the actual
implementation in the same package uses zlib.

### 2.3 Framing pitfalls

- The length field counts the body+crc32 but **not** the SOF/length/CRC-8
  header. To get total wire length: `4 + length`.
- The body itself is `length - 4` bytes (the trailing CRC-32 isn't part
  of `body`). When verifying CRC-32, compute over `data[4 : length]`.
- One BLE notification = one complete frame. There is no
  fragmentation/reassembly layer on top. ATT MTU sizing therefore
  caps the maximum payload — typical observed MTUs are ~150+ bytes,
  comfortably exceeding the 28-byte realtime and 24-byte historical
  bodies; the 96-byte realtime frames cited in the whoop-reader docs
  are an over-estimate and almost certainly never seen in this
  protocol.

## 3. PacketType enum

`PacketType` is the `body[0]` byte. The strap multiplexes packet
classes onto characteristics: COMMAND_RESPONSE arrives on
`CHAR_RESPONSE`, EVENT arrives on `CHAR_EVENT`, everything else
(realtime data, historical data, metadata, console logs, IMU streams)
arrives on `CHAR_DATA`. Host writes are always COMMAND on `CHAR_COMMAND`.

| Value (dec / hex) | Name | Direction | Characteristic | Description |
|--------:|------|-----------|----------------|-------------|
| 35 / `0x23` | `COMMAND` | host → strap | `CHAR_COMMAND` | Command frame; `cmd` is a `CommandNumber`. |
| 36 / `0x24` | `COMMAND_RESPONSE` | strap → host | `CHAR_RESPONSE` | Reply to a command; `cmd` echoes the issued `CommandNumber`. |
| 40 / `0x28` | `REALTIME_DATA` | strap → host | `CHAR_DATA` | Periodic HR+RR sample frame. Body ~28 bytes. See §8. |
| 43 / `0x2B` | `REALTIME_RAW_DATA` | strap → host | `CHAR_DATA` | Realtime "raw" sample stream (likely raw PPG channels). Triggered by `START_RAW_DATA` (cmd 81). Body layout unknown. |
| 47 / `0x2F` | `HISTORICAL_DATA` | strap → host | `CHAR_DATA` | One historical HR/RR record from flash. Body 24+ bytes. See §9. |
| 48 / `0x30` | `EVENT` | strap → host | `CHAR_EVENT` | Asynchronous device event; `cmd` is an `EventNumber`. See §5. |
| 49 / `0x31` | `METADATA` | strap → host | `CHAR_DATA` | History-dump bookkeeping (`HISTORY_START/END/COMPLETE`). See §6, §7. |
| 50 / `0x32` | `CONSOLE_LOGS` | strap → host | `CHAR_DATA` | Firmware printf output. Body is UTF-8 text with a 7-byte header, trailing NUL, and embedded `0x34 0x00 0x01` separators to strip. See §10 below. |
| 51 / `0x33` | `REALTIME_IMU_DATA_STREAM` | strap → host | `CHAR_DATA` | Live IMU (accel + gyro) sample frames. Triggered by `TOGGLE_IMU_MODE` (cmd 106). Body layout unknown; the `RawDataStreamResult` Java `toString` lists `accelerometerSamplesX/Y/Z` and `gyroscopeSamplesX/Y/Z` arrays (see `vendor/whoomp/scripts/packet.py:182`). |
| 52 / `0x34` | `HISTORICAL_IMU_DATA_STREAM` | strap → host | `CHAR_DATA` | Historical IMU dump frames. Triggered by `TOGGLE_IMU_MODE_HISTORICAL` (cmd 105). Body layout unknown. |

Source: `vendor/whoomp/packet.js:2-13`,
`vendor/whoomp/scripts/packet.py:4-14`.

## 4. Command reference

73 commands. Every value is listed below — the table is sorted by
command number for quick lookup. For each command:

- **#** — decimal number / hex
- **Name** — symbolic name from firmware extraction
- **Payload (host → strap)** — what we write after the `type|seq|cmd`
  header
- **Response (strap → host)** — what comes back as a
  `COMMAND_RESPONSE` (on `CHAR_RESPONSE`) when known
- **Notes** — what the command does and what state it triggers
- **Used by** — `whoomp` (`vendor/whoomp/`), `whoop-reader`
  (`vendor/whoop-reader/`), `whoof` (this repo, `web/js/ble/`),
  or "—" if no source actively exercises it. "defined-only" means the
  name/number is in an enum but no code path issues it.

The "Payload" column shows **just the data bytes**, i.e. the portion
after the `type|seq|cmd` header. Where the payload is unknown but
existing exercisers send `0x00` as a no-op selector byte, the entry
says `[0x00]`.

| # | Hex | Name | Payload (host→strap) | Response (strap→host) | Notes | Used by |
|---:|-----|------|----------------------|----------------------|-------|---------|
| 1 | `0x01` | `LINK_VALID` | unknown | unknown | Link-layer keepalive / handshake. No exercise found. | defined-only |
| 2 | `0x02` | `GET_MAX_PROTOCOL_VERSION` | unknown | unknown | Negotiate protocol version. | defined-only |
| 3 | `0x03` | `TOGGLE_REALTIME_HR` | `[u8 enable]` (0x00 stop, 0x01 start) | echoes cmd; starts `REALTIME_DATA` flow on `CHAR_DATA` | Subscribe/unsubscribe from the live HR/RR sample stream. | whoomp, whoof |
| 7 | `0x07` | `REPORT_VERSION_INFO` | `[0x00]` | `[u8 u8 u8] + 16 × u32le` versions; `harvard = v0.v1.v2.v3`, `boylston = v4.v5.v6.v7` | Returns firmware Harvard/Boylston version strings (and 8 more u32 fields not yet labelled). See `vendor/whoomp/whoomp.js:111-134` and `vendor/whoomp/scripts/packet.py:249-253`. | whoomp |
| 10 | `0x0A` | `SET_CLOCK` | `u32le unix_seconds` | (none observed in whoomp; presumably empty ack) | Set the strap's RTC. Our client writes a bare 4-byte unix timestamp (`web/js/ble/client.js:344-351`). | whoof |
| 11 | `0x0B` | `GET_CLOCK` | `[0x00]` | `[u8 u8] + u32le unix_seconds` at offset 2 | Read the strap's RTC. We compare it to host time and call `SET_CLOCK` if drift > 5 s. | whoomp, whoof |
| 14 | `0x0E` | `TOGGLE_GENERIC_HR_PROFILE` | `[u8 enable]` | unknown | Toggle the standard BLE Heart Rate profile (the generic GATT 0x180D service) on the strap — lets non-Whoop apps see HR. | whoomp (`scripts/whoop.py` `ghr_on`/`ghr_off`) |
| 16 | `0x10` | `TOGGLE_R7_DATA_COLLECTION` | unknown | unknown | Toggle an internal "R7" data collection mode. | defined-only |
| 19 | `0x13` | `RUN_HAPTIC_PATTERN_MAVERICK` | unknown | unknown | Likely a Maverick-codename variant of haptic pattern playback. | defined-only |
| 20 | `0x14` | `ABORT_HISTORICAL_TRANSMITS` | `[0x00]` | unknown | Abort an in-progress historical dump (graceful interrupt). We expose this as `abortHistoricalTransmits()` (`web/js/ble/client.js:361-363`) but don't currently call it. | whoof (defined, not exercised) |
| 22 | `0x16` | `SEND_HISTORICAL_DATA` | `[0x00]` | strap begins streaming `HISTORICAL_DATA` + `METADATA` on `CHAR_DATA` | Kick off the history-dump state machine (see §7). | whoomp, whoof |
| 23 | `0x17` | `HISTORICAL_DATA_RESULT` | `[0x01][u32le trim][u32le 0]` (9 bytes) | strap continues / completes dump | ACK for each `HISTORY_END` batch, telling the strap how far to advance its flash read pointer. See §7. | whoomp, whoof |
| 25 | `0x19` | `FORCE_TRIM` | `struct.pack("<LL", 0, 0)` in whoomp test code (didn't appear to work) | unknown | Force the strap to trim/free its flash log up to some offset. Probably needs two real u32 indices. | whoomp (defined, didn't work) |
| 26 | `0x1A` | `GET_BATTERY_LEVEL` | `[0x00]` | `[u8 u8] + u16le battery×10` at offset 2 (i.e. 152 = 15.2%) | Poll battery state of charge. We poll every 60 s. | whoomp, whoop-reader, whoof |
| 29 | `0x1D` | `REBOOT_STRAP` | `[0x00]` | unknown (strap drops BLE before sending) | Soft reboot the firmware. | whoomp |
| 32 | `0x20` | `POWER_CYCLE_STRAP` | unknown | unknown | Hard power cycle (vs. soft `REBOOT_STRAP`). | defined-only |
| 33 | `0x21` | `SET_READ_POINTER` | unknown (likely `u32le` flash offset) | unknown | Move the historical-data read pointer manually. Used to re-read or skip records. | defined-only |
| 34 | `0x22` | `GET_DATA_RANGE` | `[0x00]` (our speculation) | speculative: `[u8 u8] + u32le start_unix + u32le end_unix` | Query the range of timestamps currently stored in flash. We expose `getDataRange()` but it's untested; the response layout in `parseDataRangeResponse` (`web/js/ble/parsers.js:194-203`) is a guess. | whoof (defined, not validated) |
| 35 | `0x23` | `GET_HELLO_HARVARD` | `[0x00]` | ≥117-byte body; `data[7] = charging u8`, `data[9..18] = ASCII serial (9 chars)`, `data[116] = isWorn u8`, lots of telemetry in between | The post-connect "who am I" probe. Returns charging state, serial number, wrist-worn state, and ~100 bytes of internal config the field meanings of which are not all known. See `vendor/whoomp/whoomp.js:153-160` and `vendor/whoomp/scripts/whoop.py:135-142` for example hex dumps. | whoomp, whoof |
| 36 | `0x24` | `START_FIRMWARE_LOAD` | unknown | unknown | Begin OTA firmware upload (old DFU path). | defined-only |
| 37 | `0x25` | `LOAD_FIRMWARE_DATA` | unknown | unknown | Stream firmware bytes during OTA. | defined-only |
| 38 | `0x26` | `PROCESS_FIRMWARE_IMAGE` | unknown | unknown | Trigger firmware verification + install. | defined-only |
| 39 | `0x27` | `SET_LED_DRIVE` | unknown | unknown | Set PPG LED drive current. | defined-only |
| 40 | `0x28` | `GET_LED_DRIVE` | unknown | unknown | Read current LED drive setting. | defined-only |
| 41 | `0x29` | `SET_TIA_GAIN` | unknown | unknown | Set transimpedance amplifier gain for the PPG front-end. | defined-only |
| 42 | `0x2A` | `GET_TIA_GAIN` | unknown | unknown | Read TIA gain. | defined-only |
| 43 | `0x2B` | `SET_BIAS_OFFSET` | unknown | unknown | Set PPG/AFE bias offset. | defined-only |
| 44 | `0x2C` | `GET_BIAS_OFFSET` | unknown | unknown | Read AFE bias offset. | defined-only |
| 45 | `0x2D` | `ENTER_BLE_DFU` | unknown | unknown | Drop into Nordic-style BLE bootloader for full DFU. | defined-only |
| 52 | `0x34` | `SET_DP_TYPE` | unknown | unknown | Set "data path" type (DP). | defined-only |
| 53 | `0x35` | `FORCE_DP_TYPE` | unknown | unknown | Force data-path type. | defined-only |
| 63 | `0x3F` | `SEND_R10_R11_REALTIME` | unknown | unknown | Send R10/R11 (likely register dump) over realtime channel. | defined-only |
| 66 | `0x42` | `SET_ALARM_TIME` | unknown | unknown | Configure alarm time. | defined-only |
| 67 | `0x43` | `GET_ALARM_TIME` | unknown | unknown | Read alarm time. | defined-only |
| 68 | `0x44` | `RUN_ALARM` | `[0x00]` | unknown | Immediately fire the alarm haptic pattern. | whoomp |
| 69 | `0x45` | `DISABLE_ALARM` | unknown | unknown | Disable a configured alarm. | defined-only |
| 76 | `0x4C` | `GET_ADVERTISING_NAME_HARVARD` | unknown | unknown | Read the BLE advertising name (Harvard variant). | defined-only |
| 77 | `0x4D` | `SET_ADVERTISING_NAME_HARVARD` | unknown | unknown | Write the BLE advertising name (Harvard variant). | defined-only |
| 79 | `0x4F` | `RUN_HAPTICS_PATTERN` | `[u8 pattern]` (whoomp uses `0x00`; we expose `runHaptics(pattern=0)`) | unknown | Play a stored haptic pattern. | whoomp, whoof |
| 80 | `0x50` | `GET_ALL_HAPTICS_PATTERN` | unknown | unknown | Dump all configured haptic patterns. | defined-only |
| 81 | `0x51` | `START_RAW_DATA` | `[0x01]` in whoomp test code | begins `REALTIME_RAW_DATA` stream on `CHAR_DATA` | Subscribe to raw PPG channel data. Body layout unknown. | whoomp |
| 82 | `0x52` | `STOP_RAW_DATA` | `[0x01]` in whoomp test code (likely should be `0x00`) | stops `REALTIME_RAW_DATA` | Stop the raw data stream. | whoomp |
| 83 | `0x53` | `VERIFY_FIRMWARE_IMAGE` | unknown | unknown | Verify staged firmware image. | defined-only |
| 84 | `0x54` | `GET_BODY_LOCATION_AND_STATUS` | unknown | unknown | Probably reports wrist (left/right) selection + worn/charging combo. | defined-only |
| 96 | `0x60` | `ENTER_HIGH_FREQ_SYNC` | unknown | unknown | Bump BLE connection interval down (faster sync) before draining flash. Strap signals it wants this via `EventNumber.HIGH_FREQ_SYNC_PROMPT` (96). | defined-only |
| 97 | `0x61` | `EXIT_HIGH_FREQ_SYNC` | unknown | unknown | Restore default connection interval. | defined-only |
| 98 | `0x62` | `GET_EXTENDED_BATTERY_INFO` | unknown | unknown | Detailed battery telemetry (voltage, current, cycle count, etc.). | defined-only |
| 99 | `0x63` | `RESET_FUEL_GAUGE` | unknown | unknown | Reset the fuel-gauge IC's accumulated state. | defined-only |
| 100 | `0x64` | `CALIBRATE_CAPSENSE` | unknown | unknown | Recalibrate the capacitive touch sensor (double-tap detector). | defined-only |
| 105 | `0x69` | `TOGGLE_IMU_MODE_HISTORICAL` | unknown | begins `HISTORICAL_IMU_DATA_STREAM` flow | Toggle historical IMU dump. | defined-only |
| 106 | `0x6A` | `TOGGLE_IMU_MODE` | unknown | begins `REALTIME_IMU_DATA_STREAM` flow | Toggle realtime IMU streaming. | defined-only |
| 107 | `0x6B` | `ENABLE_OPTICAL_DATA` | unknown | unknown | Enable optical (PPG) data path. | defined-only |
| 108 | `0x6C` | `TOGGLE_OPTICAL_MODE` | unknown | unknown | Switch between optical modes (likely red vs. green channel). | defined-only |
| 115 | `0x73` | `START_DEVICE_CONFIG_KEY_EXCHANGE` | `[0x01]` in commented-out whoomp test | unknown | Begin a device-config key exchange (precedes `SEND_NEXT_DEVICE_CONFIG`). | defined-only |
| 116 | `0x74` | `SEND_NEXT_DEVICE_CONFIG` | `[u8 idx]` in commented-out whoomp test (iterates 0..19) | unknown | Iterate through device-config key/value pairs. | defined-only |
| 117 | `0x75` | `START_FF_KEY_EXCHANGE` | unknown | unknown | Start a feature-flag key exchange. | defined-only |
| 118 | `0x76` | `SEND_NEXT_FF` | unknown | unknown | Iterate through feature-flag values. | defined-only |
| 119 | `0x77` | `SET_DEVICE_CONFIG_VALUE` | unknown | unknown | Write a single device-config value. | defined-only |
| 120 | `0x78` | `SET_FF_VALUE` | unknown | unknown | Write a single feature-flag value. | defined-only |
| 121 | `0x79` | `GET_DEVICE_CONFIG_VALUE` | unknown | unknown | Read a single device-config value. | defined-only |
| 122 | `0x7A` | `STOP_HAPTICS` | unknown | unknown | Stop a currently-playing haptic pattern. | defined-only |
| 123 | `0x7B` | `SELECT_WRIST` | unknown | unknown | Tell the strap which wrist it's on (left/right). | defined-only |
| 124 | `0x7C` | `TOGGLE_LABRADOR_DATA_GENERATION` | unknown | unknown | "Labrador" appears to be a codename for an internal signal-processing path; this toggles its data generation. | defined-only |
| 125 | `0x7D` | `TOGGLE_LABRADOR_RAW_SAVE` | unknown | unknown | Toggle saving the raw Labrador data to flash. | defined-only |
| 128 | `0x80` | `GET_FF_VALUE` | unknown | unknown | Read a feature-flag value. | defined-only |
| 131 | `0x83` | `SET_RESEARCH_PACKET` | unknown | unknown | Write a research telemetry packet config. | defined-only |
| 132 | `0x84` | `GET_RESEARCH_PACKET` | unknown | unknown | Read research-packet config. | defined-only |
| 139 | `0x8B` | `TOGGLE_LABRADOR_FILTERED` | unknown | unknown | Toggle the Labrador filtered output path. | defined-only |
| 140 | `0x8C` | `SET_ADVERTISING_NAME` | unknown | unknown | Set BLE advertising name (newer protocol variant). | defined-only |
| 141 | `0x8D` | `GET_ADVERTISING_NAME` | unknown | unknown | Read BLE advertising name. | defined-only |
| 142 | `0x8E` | `START_FIRMWARE_LOAD_NEW` | unknown | unknown | OTA start, newer DFU variant. | defined-only |
| 143 | `0x8F` | `LOAD_FIRMWARE_DATA_NEW` | unknown | unknown | OTA data, newer DFU variant. | defined-only |
| 144 | `0x90` | `PROCESS_FIRMWARE_IMAGE_NEW` | unknown | unknown | OTA finalize, newer DFU variant. | defined-only |
| 145 | `0x91` | `GET_HELLO` | unknown | unknown | Non-Harvard variant of `GET_HELLO_HARVARD`. The default cmd in `scripts/packet.py`'s `WhoopPacket` constructor. | defined-only |

Source for the enum:
`/Users/helios/claude/whoop/vendor/whoomp/packet.js:85-160`
(73 entries). Mirrored in `vendor/whoomp/scripts/packet.py:81-155` and
`/Users/helios/claude/whoop/web/js/ble/packet.js:104-179`.

## 5. Event reference

Events arrive on `CHAR_EVENT` as `PacketType.EVENT` (48) frames where
`body[2] = cmd` is an `EventNumber`. Most events have a 5-byte
prefix: `[u8 flag, u32le unix_seconds, …]` — confirmed for `WRIST_ON`
and `WRIST_OFF` (`vendor/whoomp/scripts/packet.py:225-232`). Our
`parseEvent()` (`web/js/ble/parsers.js:120-162`) extracts the timestamp
for every event when present.

There are gaps in the numbering (e.g. 48–55 are missing), reflecting
deprecated or reserved slots in the firmware enum.

| # | Hex | Name | Semantic | Payload notes |
|---:|-----|------|----------|---------------|
| 0 | `0x00` | `UNDEFINED` | placeholder / reserved | — |
| 1 | `0x01` | `ERROR` | firmware reported an error | unknown payload |
| 2 | `0x02` | `CONSOLE_OUTPUT` | console message available | likely a kick for the consumer to drain `CONSOLE_LOGS` on `CHAR_DATA` |
| 3 | `0x03` | `BATTERY_LEVEL` | unsolicited battery level push | speculated: `[u8 flag, u16le×10, …]` — our parser tries `data[2..4] / 10` (`web/js/ble/parsers.js:144-146`) |
| 4 | `0x04` | `SYSTEM_CONTROL` | generic system control event | unknown |
| 5 | `0x05` | `EXTERNAL_5V_ON` | external 5 V rail came up (e.g. charger plugged) | timestamp |
| 6 | `0x06` | `EXTERNAL_5V_OFF` | external 5 V rail dropped | timestamp |
| 7 | `0x07` | `CHARGING_ON` | charging started | timestamp; surfaced as `chargingOn` in `parseEvent` |
| 8 | `0x08` | `CHARGING_OFF` | charging stopped | timestamp; surfaced as `chargingOff` |
| 9 | `0x09` | `WRIST_ON` | strap detected on wrist | timestamp; confirmed payload `[u8, u32le, …]` |
| 10 | `0x0A` | `WRIST_OFF` | strap detected off wrist | timestamp; confirmed payload `[u8, u32le, …]` |
| 11 | `0x0B` | `BLE_CONNECTION_UP` | BLE link came up | timestamp |
| 12 | `0x0C` | `BLE_CONNECTION_DOWN` | BLE link torn down | timestamp |
| 13 | `0x0D` | `RTC_LOST` | strap's RTC lost time (battery flat, etc.) — host should re-`SET_CLOCK` | timestamp |
| 14 | `0x0E` | `DOUBLE_TAP` | capacitive double-tap detected | timestamp; surfaced as `doubleTap` |
| 15 | `0x0F` | `BOOT` | strap booted | timestamp |
| 16 | `0x10` | `SET_RTC` | strap RTC was set (echo of `SET_CLOCK`) | timestamp |
| 17 | `0x11` | `TEMPERATURE_LEVEL` | temperature crossed a threshold | unknown |
| 18 | `0x12` | `PAIRING_MODE` | entered/left pairing mode | unknown |
| 19 | `0x13` | `SERIAL_HEAD_CONNECTED` | serial-head fixture attached (factory test) | unknown |
| 20 | `0x14` | `SERIAL_HEAD_REMOVED` | serial-head fixture removed | unknown |
| 21 | `0x15` | `BATTERY_PACK_CONNECTED` | external battery pack attached | unknown |
| 22 | `0x16` | `BATTERY_PACK_REMOVED` | external battery pack removed | unknown |
| 23 | `0x17` | `BLE_BONDED` | BLE bonding succeeded | unknown |
| 24 | `0x18` | `BLE_HR_PROFILE_ENABLED` | generic 0x180D HR profile turned on | echoes `TOGGLE_GENERIC_HR_PROFILE(1)` |
| 25 | `0x19` | `BLE_HR_PROFILE_DISABLED` | generic 0x180D HR profile turned off | echoes `TOGGLE_GENERIC_HR_PROFILE(0)` |
| 26 | `0x1A` | `TRIM_ALL_DATA` | flash trim operation started | unknown |
| 27 | `0x1B` | `TRIM_ALL_DATA_ENDED` | flash trim finished | unknown |
| 28 | `0x1C` | `FLASH_INIT_COMPLETE` | flash subsystem initialised | unknown |
| 29 | `0x1D` | `STRAP_CONDITION_REPORT` | periodic health report | unknown |
| 30 | `0x1E` | `BOOT_REPORT` | summary of last boot | unknown |
| 31 | `0x1F` | `EXIT_VIRGIN_MODE` | strap left first-time-setup ("virgin") mode | unknown |
| 32 | `0x20` | `CAPTOUCH_AUTOTHRESHOLD_ACTION` | capacitive-touch auto-threshold update | unknown |
| 33 | `0x21` | `BLE_REALTIME_HR_ON` | realtime HR stream is now on | echoes `TOGGLE_REALTIME_HR(1)` |
| 34 | `0x22` | `BLE_REALTIME_HR_OFF` | realtime HR stream is now off | echoes `TOGGLE_REALTIME_HR(0)` |
| 35 | `0x23` | `ACCELEROMETER_RESET` | accel chip was reset | unknown |
| 36 | `0x24` | `AFE_RESET` | analog front-end (PPG AFE) was reset | unknown |
| 37 | `0x25` | `SHIP_MODE_ENABLED` | strap entered ship/low-power mode | unknown |
| 38 | `0x26` | `SHIP_MODE_DISABLED` | strap left ship mode | unknown |
| 39 | `0x27` | `SHIP_MODE_BOOT` | booted out of ship mode | unknown |
| 40 | `0x28` | `CH1_SATURATION_DETECTED` | PPG channel 1 saturated | unknown |
| 41 | `0x29` | `CH2_SATURATION_DETECTED` | PPG channel 2 saturated | unknown |
| 42 | `0x2A` | `ACCELEROMETER_SATURATION_DETECTED` | accelerometer saturated | unknown |
| 43 | `0x2B` | `BLE_SYSTEM_RESET` | BLE stack reset | unknown |
| 44 | `0x2C` | `BLE_SYSTEM_ON` | BLE stack came up | unknown |
| 45 | `0x2D` | `BLE_SYSTEM_INITIALIZED` | BLE stack finished init | unknown |
| 46 | `0x2E` | `RAW_DATA_COLLECTION_ON` | raw data collection started | echoes `START_RAW_DATA` |
| 47 | `0x2F` | `RAW_DATA_COLLECTION_OFF` | raw data collection stopped | echoes `STOP_RAW_DATA` |
| 56 | `0x38` | `STRAP_DRIVEN_ALARM_SET` | a strap-side alarm was scheduled | unknown |
| 57 | `0x39` | `STRAP_DRIVEN_ALARM_EXECUTED` | strap fired a strap-side alarm | unknown |
| 58 | `0x3A` | `APP_DRIVEN_ALARM_EXECUTED` | app/host-side alarm executed | unknown |
| 59 | `0x3B` | `STRAP_DRIVEN_ALARM_DISABLED` | strap-side alarm cancelled | unknown |
| 60 | `0x3C` | `HAPTICS_FIRED` | haptic pattern playback completed | unknown |
| 63 | `0x3F` | `EXTENDED_BATTERY_INFORMATION` | async push of extended battery info | unknown; presumably mirrors `GET_EXTENDED_BATTERY_INFO` response payload |
| 96 | `0x60` | `HIGH_FREQ_SYNC_PROMPT` | strap's flash is filling, please drain history | host should run `SEND_HISTORICAL_DATA` and/or `ENTER_HIGH_FREQ_SYNC`. We trigger `downloadHistory()` (`web/js/ble/client.js:295-298`). |
| 97 | `0x61` | `HIGH_FREQ_SYNC_ENABLED` | strap accepted `ENTER_HIGH_FREQ_SYNC` | unknown |
| 98 | `0x62` | `HIGH_FREQ_SYNC_DISABLED` | strap accepted `EXIT_HIGH_FREQ_SYNC` | unknown |
| 100 | `0x64` | `HAPTICS_TERMINATED` | haptic pattern aborted (probably via `STOP_HAPTICS`) | unknown |

Source: `vendor/whoomp/packet.js:23-82`,
`vendor/whoomp/scripts/packet.py:21-79`.

Note: the enum has gaps at 48–55, 61–62, 64–95, 99 — those numbers are
reserved and we should treat any observed event in those ranges as an
unknown to investigate.

## 6. Metadata reference

`PacketType.METADATA` (49) frames arrive on `CHAR_DATA` during a
history dump. The `body[2] = cmd` byte is a `MetadataType`:

| # | Hex | Name | Body layout | Purpose |
|--:|-----|------|-------------|---------|
| 1 | `0x01` | `HISTORY_START` | `[u32le unix, u16le subsec, u32le unk]` (10 bytes) — observed in `vendor/whoomp/scripts/packet.py:266-269` | Marks the start of a batch of `HISTORICAL_DATA` frames. We extract `unix/subsec/unk` (`web/js/ble/parsers.js:105-109`) but don't act on them. |
| 2 | `0x02` | `HISTORY_END` | `[u32le unix, u16le subsec, u32le unk, u32le trim]` (14 bytes) | Marks the end of a batch. **The host must reply with `HISTORICAL_DATA_RESULT` containing `trim`** to receive the next batch. |
| 3 | `0x03` | `HISTORY_COMPLETE` | empty / very short — see hex examples in `scripts/packet.py:280` | Marks end of the entire dump. No ACK required; the loop terminates. |

The `trim` field is the strap's flash record index up to which the
host has acknowledged receipt; the strap will free those records and
advance its internal read pointer. Echoing it back is what advances
the dump (§7).

Sample hex dumps (with annotations) live in
`vendor/whoomp/scripts/packet.py:266-281`. The same offsets are
implemented in our `parseMetadata()`
(`/Users/helios/claude/whoop/web/js/ble/parsers.js:92-111`).

## 7. Historical-dump state machine

The strap stores recent HR/RR samples (and possibly other channels) in
on-flash records. The host drains these on every connect — and again
when the strap signals `HIGH_FREQ_SYNC_PROMPT` (96) that its buffer is
filling up.

### 7.1 Sequence (ASCII)

```
                              host                                  strap
                              ----                                  -----
1.  COMMAND SEND_HISTORICAL_DATA [0x00]
    ──────────────────────────────────────────────────────────────►
                                                                    starts dumping;
                                                                    metadata + records
                                                                    interleaved on
                                                                    CHAR_DATA
2.                                          ◄── METADATA HISTORY_START [unix, subsec, unk]
3.                                          ◄── HISTORICAL_DATA #1
                                                  …
3.                                          ◄── HISTORICAL_DATA #N
4.                                          ◄── METADATA HISTORY_END [unix, subsec, unk, trim]
5.  COMMAND HISTORICAL_DATA_RESULT
       [0x01, trim u32le, 0 u32le]                                  receives ACK; frees
    ──────────────────────────────────────────────────────────────► flash up to `trim`,
                                                                    starts next batch
6.                                          ◄── METADATA HISTORY_START …
7.                                          ◄── HISTORICAL_DATA …
                                          (repeats steps 2-5 per batch)
                                            …
8.                                          ◄── METADATA HISTORY_COMPLETE
9.  (loop exits)
```

The host loop is structurally identical in all three references:

- `vendor/whoomp/whoomp.js:292-325` (canonical JS).
- `vendor/whoomp/scripts/whoop.py:144-167` (CLI).
- `/Users/helios/claude/whoop/web/js/ble/client.js:372-415` (ours).

### 7.2 Pseudocode

```
send_command(SEND_HISTORICAL_DATA, [0x00])

loop:
    # Drain METADATA queue until we see END or COMPLETE.
    # (HISTORY_START frames are ignored — they're informational.)
    meta = pop_metadata()
    while meta.kind not in (HISTORY_END, HISTORY_COMPLETE):
        meta = pop_metadata()

    if meta.kind == HISTORY_COMPLETE:
        break   # dump done

    # ACK by echoing trim. Payload is exactly 9 bytes:
    #   [0x01] [trim u32le] [u32le zero padding]
    ack = bytes([0x01]) + u32le(meta.trim) + u32le(0)
    send_command(HISTORICAL_DATA_RESULT, ack)
```

`HISTORICAL_DATA` frames flow into a separate stream (we route them
to `'historicalSample'` listeners) while the loop waits on the
metadata queue. The two streams arrive on the same characteristic
(`CHAR_DATA`) but are distinguished by `PacketType` in the framing.

### 7.3 Why the queue / coroutine pattern

`HISTORICAL_DATA` and `METADATA` frames interleave arbitrarily on the
same characteristic, but the ACK loop only cares about METADATA. Using
an `AsyncQueue` (`web/js/ble/client.js:39-63`) lets the data-channel
notification handler stay simple — it just sorts frames into channels —
while the dump coroutine blocks on the metadata channel without
dropping HR records.

### 7.4 Abort

`COMMAND ABORT_HISTORICAL_TRANSMITS (20)` exists to cut the dump short.
Our client exposes it as `abortHistoricalTransmits()` but does not
currently call it. After abort, expect a `HISTORY_COMPLETE` (or just a
silent stop — needs validation).

## 8. Realtime body decode

`PacketType.REALTIME_DATA` (40) frames arrive on `CHAR_DATA` while
`TOGGLE_REALTIME_HR` is on. Observed body length is around 28 bytes
(the `vendor/whoop-reader` claim of 96 bytes appears to confuse this
with a different stream type, likely IMU). Our `parseRealtime()` is
defensive about length.

### 8.1 Confirmed layout (offsets in `body`)

| Offset | Type | Field | Notes |
|-------:|------|-------|-------|
| 0..4 | bytes | header/prefix | Appears to be a timestamp-like prefix. The whoomp Python `__str__` reinterprets it as `[u8 cmd] + [u32le unix, u16le subsec]` by prepending `cmd` to `body[:7]` (`vendor/whoomp/scripts/packet.py:209-211`) — this is a hack for printing and shouldn't be taken as the wire layout. Treat as opaque. |
| 5 | `u8` | heart rate (BPM) | The single byte the entire whoomp UI is driven from (`vendor/whoomp/whoomp.js:201`). Range 20..250 considered valid; 0 means "no detection". |
| 6 | `u8` | rrnum | Number of valid RR intervals that follow at offset 7. Range observed: 0..4. Our parser clamps to 4. |
| 7..(7+2·rrnum) | `u16le[rrnum]` | RR intervals (ms) | Up to 4 R–R intervals. Range 200..2000 ms considered valid (matches the historical packet's filter). |

Our decoder: `parseRealtime()` in
`/Users/helios/claude/whoop/web/js/ble/parsers.js:26-47`.

### 8.2 Speculative — bytes 18..91

The `vendor/whoop-reader` README and parser claim this packet is 96
bytes and lay out speculative fields for SpO2 (byte 5), skin temp
(byte 6), accelerometer (bytes 7..12), motion intensity (byte 13),
PPG amplitude/ambient/quality (bytes 14..19). **All of this is wrong**
on two counts:

1. The `vendor/whoomp` source — which is derived directly from
   firmware/Android-app disassembly — uses byte 5 as heart rate
   (uint8), byte 6 as `rrnum`, and bytes 7+ as RR intervals. There
   is no SpO2 byte in this packet type.
2. The 96-byte size in `vendor/whoop-reader/whoop_reader/parser.py`
   isn't actually observed by either whoomp's CLI or our client. The
   Python whoomp parser sizes the realtime body at 13 bytes
   (`cmd + 7 bytes header + up to 6 bytes of RR`); the JS one reads
   only through byte 7+2·rrnum.

What's *probably* in there, though, is the IMU data that's spelled
out in the `RawDataStreamResult` Java `toString` quoted in
`vendor/whoomp/scripts/packet.py:182`:

> `RawDataStreamResult(type=…, timestampSeconds=…, timestampSubseconds=…, heartRate=…, accelerometerSamplesX=[…], accelerometerSamplesY=[…], accelerometerSamplesZ=[…], gyroscopeSamplesX=[…], gyroscopeSamplesY=[…], gyroscopeSamplesZ=[…])`

The `Arrays.toString(this.f100239e)` calls indicate 6 arrays (3 accel
axes + 3 gyro axes). With i16 samples and a 32-sample window per
channel, that's `6 × 32 × 2 = 384` bytes — way more than this packet
holds — so a more likely interpretation is that this `RawDataStreamResult`
class is the decode shape for `REALTIME_IMU_DATA_STREAM` (type 51) and
*not* this `REALTIME_DATA` (type 40) packet. The realtime packet's
trailing bytes might just be padding, signal-quality flags, or
firmware bookkeeping. **This is an active TODO** — see §10.

### 8.3 Range filtering

Our parser applies the same physiological-range filters as
`vendor/whoomp/scripts/parser.py` and the Android app appears to:

- HR: 20..250 BPM (else returned as `null`).
- RR: 200..2000 ms (else dropped from the array; the field count
  doesn't shrink).

## 9. Historical body decode

`PacketType.HISTORICAL_DATA` (47) frames arrive on `CHAR_DATA` during a
history dump (§7). Body is at least 24 bytes.

### 9.1 Confirmed layout (offsets in `body`)

| Offset | Type | Field | Notes |
|-------:|------|-------|-------|
| 0..4 | bytes | header/prefix | Unknown — possibly a record type tag + flags. Our parser ignores. |
| 4 | `u32le` | unix_seconds | Sample timestamp (UTC). |
| 8 | `u16le` | subsec | Sub-second tick (units unconfirmed; likely 1/65536 s or similar). |
| 10 | `u32le` | flash_index (`unk` in whoomp; `flashIndex` in ours) | The flash record index. This is the value the strap uses for `trim` in `METADATA HISTORY_END`. Carry it through for debugging / dedupe. |
| 14 | `u8` | heart rate (BPM) | Same 20..250 filter as realtime. |
| 15 | `u8` | rrnum | Number of valid RR intervals (0..4). |
| 16..(16+2·rrnum) | `u16le[rrnum]` | RR intervals (ms) | Same 200..2000 ms filter. |

Source: `vendor/whoomp/scripts/parser.py:142-158`, replicated in
`/Users/helios/claude/whoop/web/js/ble/parsers.js:59-80`.

Note the difference vs. realtime: historical records use a `<LHLB`
prefix (`u32 + u16 + u32 + u8`) for `[unix, subsec, flashIndex, hr]`
starting at offset 4, whereas the realtime packet has a 5-byte opaque
prefix followed by `[hr_u8, rrnum_u8, rr…]` starting at offset 5.

### 9.2 What `parser.py` actually does

```python
length = struct.unpack("<H", data[dp+1:dp+3])[0] + 4  # +4 for crc32
pkt = WhoopPacket.from_data(data[dp:dp+length])
dp += length

# pkt.data is the body MINUS the type/seq/cmd header
unix, subsec, unk, heart = struct.unpack("<LHLB", pkt.data[4:4+11])
rrnum = pkt.data[15]
rr1, rr2, rr3, rr4 = struct.unpack("<HHHH", pkt.data[16:24])
```

The `parser.py` file iterates over a binary stream of concatenated raw
frames (the `historical_data_stream.bin` file written by
`vendor/whoomp/whoomp.js`'s `FileStreamHandler`).

## 10. Console logs

`PacketType.CONSOLE_LOGS` (50) frames carry firmware `printf` output
on `CHAR_DATA`. The body layout is:

```
[7 bytes header (timestamp + framing)] [UTF-8 text] [0x00 trailer]
```

With embedded 3-byte separators `0x34 0x00 0x01` that must be stripped.

Decoder: `parseConsoleLog()` in
`/Users/helios/claude/whoop/web/js/ble/parsers.js:227-244` and
`processLogData()` in `vendor/whoomp/whoomp.js:217-246`. The Python
mirror is the special-cased `__str__` branch in
`vendor/whoomp/scripts/packet.py:283-287`.

The hex examples at `vendor/whoomp/scripts/packet.py:284-286` show
two log lines being assembled from the cleaned bytes:

> ` rds = 2\n 10, 3167802: SIGPROC-WEAR-DETECT V3: movi…`
> `ng from state 1 to state 3 (debug = 4), state_cnt …`
> `ealtime HR disabled\n 10, 3237620: Sensors: Realtim…`

## 11. Known unknowns / TODO

Ordered roughly by how much pain they cause:

1. **Realtime body bytes 18..91 (or whatever the true end is).** We
   don't know the actual packet length distribution. Capture an HCI
   snoop or instrument our `_onData` handler to log
   `data.length` histograms before assuming any layout. If the IMU
   samples really are inline (per the speculative whoop-reader docs),
   this is a 6-channel × ~5-sample-per-frame motion stream we're
   currently throwing away.
2. **`REALTIME_IMU_DATA_STREAM` (type 51) body format.** The Java
   `RawDataStreamResult` `toString` (cited in §8.2) implies
   `[type, timestampSeconds, timestampSubseconds, heartRate, accelX[], accelY[], accelZ[], gyroX[], gyroY[], gyroZ[]]`,
   but we don't know element type (i16le seems likely from Whoop's
   typical sensors: LSM6DSO-class IMU) or array length. Decode after
   issuing `TOGGLE_IMU_MODE (106)` and recording a frame batch.
3. **`HISTORICAL_IMU_DATA_STREAM` (type 52) body format.** Probably
   the same layout as type 51 with a timestamp prefix and a flash
   index. Triggered by `TOGGLE_IMU_MODE_HISTORICAL (105)`.
4. **`REALTIME_RAW_DATA` (type 43) body format.** Raw PPG channel
   data, triggered by `START_RAW_DATA (81)`. whoomp's CLI exposes
   the toggle but doesn't decode the body.
5. **`GET_DATA_RANGE (34)` response.** Our `parseDataRangeResponse`
   (`web/js/ble/parsers.js:194-203`) assumes `[u8 u8, u32le start, u32le end]`
   = 10 bytes total — pure guess. Validate by calling
   `getDataRange()` and dumping `data.hex()`.
6. **`GET_EXTENDED_BATTERY_INFO (98)` response.** Likely contains
   voltage (mV), current (mA, signed), state-of-charge (%), and
   cycle count, but the byte layout is unknown.
7. **`GET_HELLO_HARVARD (35)` response — full field map.** We know
   `data[7]=charging`, `data[9..18]=serial ASCII`, `data[116]=isWorn`.
   The other ~100 bytes are telemetry — recent boot reasons,
   capacitive thresholds, sensor calibration constants. The example
   hex dumps at `vendor/whoomp/scripts/whoop.py:135-142` and
   `vendor/whoomp/scripts/whoop.py:64` would be a good corpus to
   diff for variable fields.
8. **Memfault / diagnostic channel (`CHAR_DIAG`, UUID `…0007`).**
   `vendor/whoomp/scripts/whoop.py:10` defines the UUID and a no-op
   `memfault_handler`. Memfault publishes a binary "Chunks" format
   (see the `vendor/whoomp` reverse-engineering for hints), but
   we've never actually parsed it.
9. **Most COMMAND payload/response layouts.** The bulk of the
   command table in §4 is `unknown`/`unknown` — this is the long
   tail. Decoding strategy: pick a command, find it in the Android
   app's bytecode (or a HCI snoop from the official app), then
   document here.
10. **Event payload formats beyond `[u8, u32le unix]`.** Many events
    almost certainly carry extra fields (`STRAP_CONDITION_REPORT`
    will be the juiciest — likely contains the sensor diagnostics
    feeding the strap-condition LEDs). Currently we just stash the
    raw `data` and a timestamp.
11. **`seq` semantics.** We increment a per-host counter and put it
    in our outgoing `body[1]`. The strap appears to set its own
    counter independently. Nothing currently checks that the strap's
    response `seq` matches a request's `seq`, so out-of-order
    responses would go uncorrelated. Worth verifying whether the
    strap actually echoes `seq`.

## 12. References

### Vendored

| Path | What it is |
|------|-----------|
| `/Users/helios/claude/whoop/vendor/whoomp/packet.js` | Canonical JS enum/framing source. |
| `/Users/helios/claude/whoop/vendor/whoomp/whoomp.js` | Working JS client (connect, realtime, history). |
| `/Users/helios/claude/whoop/vendor/whoomp/scripts/packet.py` | Python mirror of enums + framing, with annotation comments (e.g. `RawDataStreamResult` hint at line 182). |
| `/Users/helios/claude/whoop/vendor/whoomp/scripts/parser.py` | Historical-record body decoder. |
| `/Users/helios/claude/whoop/vendor/whoomp/scripts/whoop.py` | Python CLI exerciser (bleak); includes `CHAR_MEMFAULT` UUID definition and commented-out experiments for `START_DEVICE_CONFIG_KEY_EXCHANGE` etc. |
| `/Users/helios/claude/whoop/vendor/whoomp/README.md` | Project notes (firmware extraction methodology). |
| `/Users/helios/claude/whoop/vendor/whoop-reader/whoop_reader/protocol.py` | Secondary protocol module; partly mislabels event/data channels and miscredits CRC params (see §1.3). |
| `/Users/helios/claude/whoop/vendor/whoop-reader/whoop_reader/parser.py` | Secondary realtime parser; wrong about offsets — do not use as truth. |
| `/Users/helios/claude/whoop/vendor/whoop-reader/README.md` | Useful prose context, but its CRC-32 spec is wrong. |

### Our codebase

| Path | What it is |
|------|-----------|
| `/Users/helios/claude/whoop/web/js/ble/uuids.js` | Service + characteristic UUIDs. |
| `/Users/helios/claude/whoop/web/js/ble/crc.js` | `crc8`, `crc32Whoop` (zlib-compatible). |
| `/Users/helios/claude/whoop/web/js/ble/packet.js` | `PacketType`/`MetadataType`/`EventNumber`/`CommandNumber` enums + reverse-lookup tables; `WhoopPacket` class with `framed()` and `fromData()`. |
| `/Users/helios/claude/whoop/web/js/ble/parsers.js` | Body decoders for realtime, historical, metadata, event, console-log, common responses (battery, clock, hello, data-range). Top-level `decodePacket()` dispatcher. |
| `/Users/helios/claude/whoop/web/js/ble/client.js` | `WhoopClient`: GATT lifecycle, notification handlers, async meta queue, history-dump state machine, command senders, auto-reconnect. |
