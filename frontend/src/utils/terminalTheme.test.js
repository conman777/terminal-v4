import { afterEach, describe, expect, it } from 'vitest';
import { getTerminalTheme } from './terminalTheme';

function clearThemeVars() {
  const root = document.documentElement.style;
  root.removeProperty('--terminal-bg');
  root.removeProperty('--bg-surface');
  root.removeProperty('--text-primary');
  root.removeProperty('--accent-primary-dim');
}

describe('getTerminalTheme', () => {
  afterEach(() => {
    clearThemeVars();
  });

  it('prefers the dedicated terminal background variable and includes ANSI colors', () => {
    const root = document.documentElement.style;
    root.setProperty('--terminal-bg', '#10243a');
    root.setProperty('--bg-surface', '#0f172a');
    root.setProperty('--text-primary', '#f5f7ff');
    root.setProperty('--accent-primary-dim', 'rgba(34, 211, 238, 0.2)');

    expect(getTerminalTheme('dark')).toMatchObject({
      background: '#10243a',
      foreground: '#f5f7ff',
      cursor: '#f5f7ff',
      cursorAccent: '#10243a',
      selectionBackground: 'rgba(34, 211, 238, 0.2)',
      green: '#0dbc79',
      brightBlue: '#3b8eea',
    });
  });

  it('falls back to the shared surface color when no terminal background is set', () => {
    const root = document.documentElement.style;
    root.setProperty('--bg-surface', '#203040');
    root.setProperty('--text-primary', '#dde7f5');

    expect(getTerminalTheme('dark')).toMatchObject({
      background: '#203040',
      foreground: '#dde7f5',
      cursor: '#dde7f5',
      cursorAccent: '#203040',
    });
  });

  it('uses light ANSI table for light mode', () => {
    expect(getTerminalTheme('light')).toMatchObject({
      yellow: '#949800',
      green: '#00bc00',
    });
  });
});
