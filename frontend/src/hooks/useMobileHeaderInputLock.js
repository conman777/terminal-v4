import { useEffect, useState } from 'react';

export function shouldLockMobileHeaderForElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const isEditable = element.matches('input, textarea, [contenteditable], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
    || element.isContentEditable;

  if (!isEditable) {
    return false;
  }

  return element.getAttribute('aria-label') !== 'Terminal input';
}

export function useMobileHeaderInputLock(enabled) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      setLocked(false);
      return undefined;
    }

    let frameId = null;

    const syncLockState = () => {
      setLocked(shouldLockMobileHeaderForElement(document.activeElement));
    };

    const scheduleSync = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        syncLockState();
      });
    };

    syncLockState();
    document.addEventListener('focusin', scheduleSync);
    document.addEventListener('focusout', scheduleSync);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      document.removeEventListener('focusin', scheduleSync);
      document.removeEventListener('focusout', scheduleSync);
    };
  }, [enabled]);

  return locked;
}
