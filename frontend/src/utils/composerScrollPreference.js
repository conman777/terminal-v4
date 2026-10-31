export const COMPOSER_SCROLL_KEY = 'tv4.composerCollapseOnScroll';

const listeners = new Set();
let temporaryValue = null;

export function getComposerScrollPreference() {
  if (temporaryValue !== null) return temporaryValue;
  try { return localStorage.getItem(COMPOSER_SCROLL_KEY) !== 'false'; } catch { return true; }
}

export function setComposerScrollPreference(value) {
  let saved = false;
  try {
    localStorage.setItem(COMPOSER_SCROLL_KEY, String(Boolean(value)));
    temporaryValue = null;
    saved = true;
  } catch { temporaryValue = Boolean(value); }
  listeners.forEach(listener => listener());
  return saved;
}

function onStorage(event) {
  if (event.key !== COMPOSER_SCROLL_KEY && event.key !== null) return;
  try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
  temporaryValue = null;
  listeners.forEach(listener => listener());
}

export function subscribeComposerScrollPreference(listener) {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}
