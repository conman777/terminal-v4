export const TERMINAL_THEME_FALLBACKS = {
  dark: {
    background: '#0f172a',
    foreground: '#f8fafc',
    cursor: '#f8fafc',
    cursorAccent: '#0f172a',
    selectionBackground: 'rgba(34, 211, 238, 0.16)',
  },
  light: {
    background: '#eef2ff',
    foreground: '#0f172a',
    cursor: '#0f172a',
    cursorAccent: '#eef2ff',
    selectionBackground: 'rgba(8, 145, 178, 0.12)',
  }
};

export function getTerminalTheme(themeName) {
  const fallback = TERMINAL_THEME_FALLBACKS[themeName] || TERMINAL_THEME_FALLBACKS.dark;
  if (typeof window === 'undefined') return fallback;

  const styles = window.getComputedStyle(document.documentElement);
  const readVar = (name, fallbackValue) => styles.getPropertyValue(name)?.trim() || fallbackValue;
  const background = readVar('--terminal-bg', readVar('--bg-surface', fallback.background));

  return {
    background,
    foreground: readVar('--text-primary', fallback.foreground),
    cursor: readVar('--text-primary', fallback.cursor),
    cursorAccent: background,
    selectionBackground: readVar('--accent-primary-dim', fallback.selectionBackground),
  };
}
