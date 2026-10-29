import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { KeyboardShortcutsSetting } from './KeyboardShortcutsSetting';
import { loadBindings } from '../utils/keybindings';

beforeEach(() => localStorage.clear());

describe('KeyboardShortcutsSetting', () => {
  it('records a new shortcut for an action and can reset them all', () => {
    render(<KeyboardShortcutsSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Change Command palette shortcut' }));
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, metaKey: true, altKey: true });
    const changed = loadBindings().commandPalette;
    fireEvent.click(screen.getByRole('button', { name: 'Reset shortcuts' }));
    expect([changed, loadBindings().commandPalette]).toEqual(['mod+alt+j', 'mod+k']);
  });
});
