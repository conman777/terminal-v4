export function isWindowActive() {
  if (typeof document === 'undefined') {
    return true;
  }
  if (document.hidden || document.visibilityState === 'hidden') {
    return false;
  }
  if (typeof document.hasFocus === 'function') {
    return document.hasFocus();
  }
  return true;
}

export function subscribeWindowActivity(listener) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const handleChange = () => {
    listener(isWindowActive());
  };

  document.addEventListener('visibilitychange', handleChange);
  window.addEventListener('focus', handleChange);
  window.addEventListener('blur', handleChange);

  return () => {
    document.removeEventListener('visibilitychange', handleChange);
    window.removeEventListener('focus', handleChange);
    window.removeEventListener('blur', handleChange);
  };
}
