// Minimal event emitter. Used by WhoopClient to fan BLE events out to the UI.

export function createEmitter() {
  const listeners = new Map(); // event -> Set<fn>
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (err) { console.error('[emitter]', event, err); }
      }
    },
  };
}
