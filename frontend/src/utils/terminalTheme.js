export const TERMINAL_THEME_FALLBACKS = {
  dark: {
    background: '#1a1713',
    foreground: '#f4eee3',
    cursor: '#f4eee3',
    cursorAccent: '#1a1713',
    selectionBackground: 'rgba(217, 119, 6, 0.18)',
  },
  light: {
    background: '#f5eedb',
    foreground: '#1f1a13',
    cursor: '#1f1a13',
    cursorAccent: '#f5eedb',
    selectionBackground: 'rgba(180, 83, 9, 0.14)',
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
