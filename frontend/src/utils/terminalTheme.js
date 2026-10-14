// VS Code / stable-terminal fixed ANSI tables per theme mode. Partial CSS vars
// overlay only the slots they define so colors stay legible (e.g. yellow on
// light backgrounds).

const DARK_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

const LIGHT_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

export const TERMINAL_THEME_FALLBACKS = {
  dark: {
    background: '#1a1713',
    foreground: '#f4eee3',
    cursor: '#f4eee3',
    cursorAccent: '#1a1713',
    selectionBackground: 'rgba(217, 119, 6, 0.18)',
    ...DARK_ANSI,
  },
  light: {
    background: '#f5eedb',
    foreground: '#1f1a13',
    cursor: '#1f1a13',
    cursorAccent: '#f5eedb',
    selectionBackground: 'rgba(180, 83, 9, 0.14)',
    ...LIGHT_ANSI,
  }
};

export function getTerminalTheme(themeName) {
  const mode = themeName === 'light' ? 'light' : 'dark';
  const fallback = TERMINAL_THEME_FALLBACKS[mode];
  if (typeof window === 'undefined') return { ...fallback };

  const styles = window.getComputedStyle(document.documentElement);
  const readVar = (name, fallbackValue) => styles.getPropertyValue(name)?.trim() || fallbackValue;
  const background = readVar('--terminal-bg', readVar('--bg-surface', fallback.background));
  const foreground = readVar('--text-primary', fallback.foreground);

  return {
    ...fallback,
    background,
    foreground,
    cursor: readVar('--text-primary', fallback.cursor),
    // Match surface so the cursor block doesn't flash white on dark themes.
    cursorAccent: background,
    selectionBackground: readVar('--accent-primary-dim', fallback.selectionBackground),
  };
}
