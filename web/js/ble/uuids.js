// Whoop custom GATT service + characteristic UUIDs, both generations.
// Command/event/packet enums live in packet.js.
//
//   WHOOP 4.0 ("GEN4")  → 61080001..7-8d6d-82b8-614a-1c8cb0f8dcc6
//   WHOOP 5.0 ("Puffin")→ fd4b0001..7-cce1-4033-93ce-002d5875f58a
//
// Both families use the same characteristic-slot convention:
//   0001 service, 0002 command(write), 0003 response, 0004 event,
//   0005 data, 0007 diag. Slot 0006 exists only on 5.0 and is unused.

export const FAMILIES = Object.freeze({
  whoop4: {
    name: 'WHOOP 4.0',
    service:  '61080001-8d6d-82b8-614a-1c8cb0f8dcc6',
    command:  '61080002-8d6d-82b8-614a-1c8cb0f8dcc6',
    response: '61080003-8d6d-82b8-614a-1c8cb0f8dcc6',
    event:    '61080004-8d6d-82b8-614a-1c8cb0f8dcc6',
    data:     '61080005-8d6d-82b8-614a-1c8cb0f8dcc6',
    diag:     '61080007-8d6d-82b8-614a-1c8cb0f8dcc6',
  },
  whoop5: {
    name: 'WHOOP 5.0',
    service:  'fd4b0001-cce1-4033-93ce-002d5875f58a',
    command:  'fd4b0002-cce1-4033-93ce-002d5875f58a',
    response: 'fd4b0003-cce1-4033-93ce-002d5875f58a',
    event:    'fd4b0004-cce1-4033-93ce-002d5875f58a',
    data:     'fd4b0005-cce1-4033-93ce-002d5875f58a',
    diag:     'fd4b0007-cce1-4033-93ce-002d5875f58a',
  },
});

// Standard SIG services we read on 5.0 for firmware/model/battery (4.0 carries
// these in the GET_HELLO_HARVARD blob instead).
export const STD_SERVICE = Object.freeze({
  HEART_RATE:  '0000180d-0000-1000-8000-00805f9b34fb',
  BATTERY:     '0000180f-0000-1000-8000-00805f9b34fb',
  DEVICE_INFO: '0000180a-0000-1000-8000-00805f9b34fb',
});

// Backward-compat exports — existing callers (4.0) keep working unchanged.
export const SERVICE_UUID       = FAMILIES.whoop4.service;
export const CHAR_COMMAND_UUID  = FAMILIES.whoop4.command;
export const CHAR_RESPONSE_UUID = FAMILIES.whoop4.response;
export const CHAR_EVENT_UUID    = FAMILIES.whoop4.event;
export const CHAR_DATA_UUID     = FAMILIES.whoop4.data;
export const CHAR_DIAG_UUID     = FAMILIES.whoop4.diag;
