# WHOOP 5.0 skin-temp / respiratory — candidate capture

WHOOP 5.0 ("Puffin") straps carry sensors the 4.0 didn't expose over BLE:
skin temperature and respiratory rate. whoof **captures the raw candidate
packets** that carry them, but does **not** decode a temperature or RPM value —
because the byte layout is not yet confirmed against a real strap.

This doc records what is known (so the offsets can be verified later) and what
whoof deliberately does *not* do (so nobody ships a fabricated reading).

## Why we don't decode yet

The reference implementation (`goose`, an iOS/Swift WHOOP 5.0 client) *does*
contain candidate offset math, but labels every value `plausible_unverified_units`
and never writes it to its health store — it only shows them as debug-status
strings. Its live BLE path doesn't decode K18/K24 at all; it mirrors the raw
packets to a SQLite table (`k_revision` column) for **offline** analysis. So
there is no confirmed decode to port — only a capture-and-classify scaffold.

whoof's CLAUDE.md forbids speculative/fabricated code, so we match goose's
*honest* behaviour: classify, capture, surface for analysis. No value math.

## What whoof does (shipped)

- **Acquires the diag characteristic** (slot `0007`, both families) when present.
  Optional — its absence never aborts a connection.
- **`sendDebugSkinTempCommand()`** — writes a raw 2-byte `[0x73, 0x0a]` to the
  diag char (no V5 framing, fire-and-forget, exactly as goose does). Called once
  per 5.0 connection in `_postConnectFlow` (step 3b) to prompt the strap to emit
  skin-temp candidate packets.
- **`rawCandidate` event** — every 5.0 `HISTORICAL_DATA` (type 47) frame is
  emitted as `{ kRevision, cmd, data }` where `kRevision = payload[1]` (the
  strap's record-format byte; `= raw notification byte[9]`, goose's
  discriminator). The 4.0 `parseHistorical` is **not** run on 5.0 bodies — doing
  so would fabricate a heart rate from the wrong offset.
- **Event tagging** — `TEMPERATURE_LEVEL` (17) and `STRAP_CONDITION_REPORT` (29)
  events are tagged (`semantic`) and pass their raw bytes through (`evt.raw`),
  no value decode.

`kRevision` 18 (K18) and 24 (K24) are the frames goose associates with the
skin-temp / respiratory candidates.

## Unverified offsets (from goose — DO NOT implement until confirmed)

Recorded here only so a future verification pass has a starting hypothesis.
These are `plausible_unverified_units` in goose and **must not** be turned into
live decode without checking against a physical 5.0 strap:

| Field            | Frame | Offset (in packet body) | Encoding   | Hypothesised scale |
|------------------|-------|-------------------------|------------|--------------------|
| Skin temp        | K18   | `body[24..25]`          | i16-LE     | `/ 100.0` → °C     |
| Respiratory rate | K18   | `body[26..27]`          | u16-LE     | `/ 10.0`  → rpm    |
| Skin temp        | K24   | `body[3..4]`            | u16-LE     | `/ 1000.0` → °C    |

The event-17 multi-offset brute-force scan goose runs (offsets 0–11, 8
encodings, 20–45 °C gate) is an exploratory search, not a decode — not ported.

## Verifying with a real strap (next steps)

1. Connect a 5.0 strap; listen for `rawCandidate` and persist the bytes
   (the existing capture/export tooling can sink them).
2. Confirm which `kRevision` values actually arrive and how often.
3. Wear-test against a known reference (e.g. a thermometer / breaths-per-minute
   count) to confirm the offset + scale before writing any `parseHistoricalV5`.
4. Only then add a **separate** `parseHistoricalV5` decoder (do not merge into
   the 4.0 `parseHistorical` — the 4.0 `heart@data[14]` layout is correct and
   must stay untouched).

### Also unverified: GET_DATA_RANGE pre-flight

goose sends `GET_DATA_RANGE` (cmd 34) and waits for its response before
`SEND_HISTORICAL_DATA` (cmd 22) — a request/response handshake that helps elicit
the candidate packets. whoof has `getDataRange()` plumbed but does **not** insert
it into `downloadHistory()`, because the handshake *timing* can't be validated
without a strap and an unsequenced cmd-34 could disrupt the working sync. Add it
(awaiting the range response) once a strap is available to test against.
