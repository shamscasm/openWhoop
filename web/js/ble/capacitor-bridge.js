// Web Bluetooth → Capacitor BLE bridge (no-bundler version).
//
// When the dashboard is loaded inside a Capacitor native app (iOS / Android),
// `navigator.bluetooth` does not exist — those platforms' WKWebView/WebView
// deliberately exclude the Web Bluetooth API. Instead, native BLE is exposed
// via the @capacitor-community/bluetooth-le plugin, which Capacitor exposes
// on the global as `window.Capacitor.Plugins.BluetoothLe`.
//
// Rather than rewrite every caller, this module synthesises a
// Web-Bluetooth-compatible `navigator.bluetooth` object on top of that
// plugin, so the existing BLE client code (`ble/client.js`,
// `health/scale.js`) keeps working unchanged in the native shell.
//
// In a regular browser (Chrome, Edge, Arc) this module is a no-op — the
// real `navigator.bluetooth` is used.

const isCapacitor = !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());

function int16ToDataView(b) { return new DataView(new Uint8Array(b).buffer); }

/**
 * Install the bridge if and only if we're inside Capacitor.
 * Idempotent — safe to call multiple times.
 */
export async function installCapacitorBleBridge() {
  if (!isCapacitor) return false;
  if (navigator.bluetooth?._isCapacitorBridge) return true; // already installed

  const Ble = window.Capacitor?.Plugins?.BluetoothLe;
  if (!Ble) {
    console.warn('[ble-bridge] BluetoothLe plugin not registered on window.Capacitor.Plugins');
    return false;
  }

  await Ble.initialize({ androidNeverForLocation: true }).catch((err) => {
    console.warn('[ble-bridge] init failed', err);
  });

  // Cache of device wrappers so the same deviceId returns the same instance.
  const deviceById = new Map();

  // Capacitor's plugin marshals DataViews through JSON as base64 in many
  // versions. Normalise to a DataView regardless of what comes back.
  function toDataView(v) {
    if (v instanceof DataView) return v;
    if (v instanceof ArrayBuffer) return new DataView(v);
    if (v?.value && typeof v.value === 'string') {
      // base64-encoded byte string
      const bin = atob(v.value);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new DataView(buf.buffer);
    }
    if (typeof v === 'string') {
      const bin = atob(v);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new DataView(buf.buffer);
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      return new DataView(new Uint8Array(v).buffer);
    }
    return new DataView(new ArrayBuffer(0));
  }

  function dataToBase64(data) {
    let bytes;
    if (data instanceof DataView) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else bytes = new Uint8Array(data);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function makeCharacteristic(deviceId, serviceUuid, charUuid) {
    const listeners = new Set();
    let notifying = false;
    const ch = {
      uuid: charUuid,
      service: { uuid: serviceUuid },
      properties: { notify: true, write: true, writeWithoutResponse: true, read: true },
      value: null,

      async readValue() {
        const res = await Ble.read({ deviceId, service: serviceUuid, characteristic: charUuid });
        ch.value = toDataView(res);
        return ch.value;
      },

      async writeValue(data) {
        await Ble.write({
          deviceId, service: serviceUuid, characteristic: charUuid,
          value: dataToBase64(data),
        });
      },

      async writeValueWithoutResponse(data) {
        await Ble.writeWithoutResponse({
          deviceId, service: serviceUuid, characteristic: charUuid,
          value: dataToBase64(data),
        });
      },

      async startNotifications() {
        if (notifying) return ch;
        // Capacitor's BluetoothLe sends a 'notification' event with deviceId/service/characteristic.
        // For convenience, also accept the callback form.
        try {
          await Ble.startNotifications(
            { deviceId, service: serviceUuid, characteristic: charUuid },
            (data) => fire(data),
          );
        } catch {
          // Fallback: subscribe via plugin listener
          await Ble.startNotifications({ deviceId, service: serviceUuid, characteristic: charUuid });
          Ble.addListener?.(`notification|${deviceId}|${serviceUuid}|${charUuid}`, (data) => fire(data));
        }
        notifying = true;
        return ch;

        function fire(data) {
          ch.value = toDataView(data);
          const ev = new Event('characteristicvaluechanged');
          Object.defineProperty(ev, 'target', { value: ch, enumerable: true });
          for (const fn of listeners) {
            try { fn(ev); } catch (e) { console.error('[ble-bridge] listener', e); }
          }
        }
      },

      async stopNotifications() {
        if (!notifying) return ch;
        await Ble.stopNotifications({ deviceId, service: serviceUuid, characteristic: charUuid })
          .catch(() => {});
        notifying = false;
        return ch;
      },

      addEventListener(event, fn) {
        if (event === 'characteristicvaluechanged') listeners.add(fn);
      },
      removeEventListener(event, fn) {
        if (event === 'characteristicvaluechanged') listeners.delete(fn);
      },
    };
    return ch;
  }

  function makeService(deviceId, serviceUuid) {
    return {
      uuid: serviceUuid,
      device: deviceById.get(deviceId),
      async getCharacteristic(uuid) {
        return makeCharacteristic(deviceId, serviceUuid, String(uuid).toLowerCase());
      },
      async getCharacteristics() { return []; },
    };
  }

  function makeServer(deviceId, device) {
    const server = {
      connected: false,
      device,
      async connect() {
        const onDisconnected = () => {
          server.connected = false;
          device.dispatchEvent(new Event('gattserverdisconnected'));
        };
        // @capacitor-community/bluetooth-le v3 reads the disconnect callback
        // from the `onDisconnected` option; v2 took it as the 2nd positional
        // arg. Pass both so a drop always propagates and reconnect/backoff
        // fires — under v3 the old 2-arg form was silently ignored, freezing
        // the app on BLE loss.
        await Ble.connect({ deviceId, onDisconnected }, onDisconnected);
        server.connected = true;
        return server;
      },
      disconnect() {
        Ble.disconnect({ deviceId }).catch(() => {});
        server.connected = false;
      },
      async getPrimaryService(uuid) {
        return makeService(deviceId, String(uuid).toLowerCase());
      },
    };
    return server;
  }

  function makeDevice(rawDevice) {
    const id = rawDevice.deviceId;
    const cached = deviceById.get(id);
    if (cached) return cached;

    const listeners = new Map();
    const device = {
      id,
      name: rawDevice.name ?? rawDevice.localName ?? 'Whoop',
      _isCapacitorBridgeDevice: true,
      gatt: null,
      addEventListener(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
      },
      removeEventListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev.type);
        if (set) for (const fn of set) { try { fn(ev); } catch (e) { console.error(e); } }
        return true;
      },
    };
    device.gatt = makeServer(id, device);
    deviceById.set(id, device);
    return device;
  }

  const bridge = {
    _isCapacitorBridge: true,
    async getAvailability() { return true; },

    async requestDevice({ filters = [], optionalServices = [] } = {}) {
      const services = [];
      let namePrefix;
      for (const f of filters) {
        if (Array.isArray(f.services)) services.push(...f.services.map((u) => String(u).toLowerCase()));
        if (f.namePrefix && !namePrefix) namePrefix = f.namePrefix;
      }
      for (const s of optionalServices) services.push(String(s).toLowerCase());
      const raw = await Ble.requestDevice({
        services: services.length ? services : undefined,
        namePrefix,
        optionalServices: optionalServices.map((u) => String(u).toLowerCase()),
      });
      return makeDevice(raw);
    },

    async getDevices() {
      // Capacitor's plugin doesn't enumerate paired devices in a portable way;
      // callers will fall through to requestDevice() which is fine.
      return [];
    },
  };

  try {
    Object.defineProperty(navigator, 'bluetooth', { value: bridge, configurable: true });
  } catch {
    navigator.bluetooth = bridge;
  }
  console.info('[ble-bridge] navigator.bluetooth installed (Capacitor → BLE plugin)');
  return true;
}

// Auto-install on module load when in Capacitor.
if (isCapacitor) {
  installCapacitorBleBridge().catch((err) => {
    console.warn('[ble-bridge] install failed', err);
  });
}
