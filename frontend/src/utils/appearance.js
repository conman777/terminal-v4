const KEY = 'tv4Appearance';
export const ACCENTS = ['indigo', 'violet', 'teal', 'amber', 'rose'];
export const CHAT_WIDTHS = { comfortable: '46rem', wide: '60rem', full: '100%' };
export const DEFAULTS = Object.freeze({ accent: 'indigo', width: 'comfortable' });

export function loadAppearance() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  return {
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULTS.accent,
    width: Object.hasOwn(CHAT_WIDTHS, saved.width) ? saved.width : DEFAULTS.width,
  };
}

export function saveAppearance(appearance) {
  try { localStorage.setItem(KEY, JSON.stringify(appearance)); } catch { /* applies this session only */ }
}

// Accent colours are CSS presets keyed by data-accent; the width feeds --workspace-chat-width.
export function applyAppearance({ accent, width }, root = document.documentElement) {
  if (accent === DEFAULTS.accent) root.removeAttribute('data-accent'); else root.setAttribute('data-accent', accent);
  root.style.setProperty('--user-chat-width', CHAT_WIDTHS[width] || CHAT_WIDTHS.comfortable);
}
