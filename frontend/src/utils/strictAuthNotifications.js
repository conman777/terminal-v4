// Notifications contain no session data and are only a hint to reread authority.
export function createStrictAuthNotifications(options = {}) {
  const Channel = Object.hasOwn(options, 'BroadcastChannel') ? options.BroadcastChannel : globalThis.BroadcastChannel;
  const listeners = new Set();
  let channel, available = false;
  const notify = value => { for (const listener of listeners) { try { listener(value); } catch { /* One subscriber cannot block others. */ } } };
  const fail = () => {
    if (!available) return;
    available = false;
    notify({ status: 'unavailable' });
  };
  try {
    if (typeof Channel === 'function') {
      channel = new Channel('terminal-v4-strict-auth-authority-v1');
      available = true;
      channel.onmessage = event => {
        const value = event.data;
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'kind,version'
          || value.version !== 1 || value.kind !== 'authority-changed') return;
        notify({ status: 'changed' });
      };
      channel.onmessageerror = fail;
    }
  } catch { available = false; }
  return {
    subscribe(listener) {
      if (!available || typeof listener !== 'function') throw new Error('Strict authentication notifications unavailable');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish() {
      if (!available) return false;
      try { channel.postMessage({ version: 1, kind: 'authority-changed' }); }
      catch { fail(); return false; }
      notify({ status: 'changed' });
      return true;
    },
    close() { fail(); listeners.clear(); try { channel?.close(); } catch { /* Already closed. */ } },
  };
}
