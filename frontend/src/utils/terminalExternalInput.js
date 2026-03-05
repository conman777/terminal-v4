export function prepareTerminalForExternalInput({
  requestPriorityResize,
  focusTerminal,
  setMobileInputEnabled,
}) {
  if (typeof requestPriorityResize === 'function') {
    try {
      requestPriorityResize();
    } catch {
      // Ignore transient resize/promotion failures during mount/reconnect.
    }
  }

  if (typeof focusTerminal === 'function') {
    try {
      focusTerminal();
    } catch {
      // Ignore focus failures when the terminal is reconnecting.
    }
  }

  if (typeof setMobileInputEnabled === 'function') {
    setMobileInputEnabled(true);
  }
}
