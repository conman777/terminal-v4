function hasFocusedEditableElement() {
  if (typeof document === 'undefined') {
    return false;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || activeElement === document.body) {
    return false;
  }

  return activeElement.matches('input, textarea, [contenteditable], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
    || activeElement.isContentEditable;
}

export function isWindowActive() {
  if (typeof document === 'undefined') {
    return true;
  }
  if (document.hidden || document.visibilityState === 'hidden') {
    return false;
  }
  if (hasFocusedEditableElement()) {
    return true;
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
