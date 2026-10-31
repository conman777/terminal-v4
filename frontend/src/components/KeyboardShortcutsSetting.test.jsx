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

  it('keeps the original shortcut and explains a conflicting assignment until a valid choice is made', () => {
    render(<KeyboardShortcutsSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Change Command palette shortcut' }));
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });
    expect(loadBindings().commandPalette).toBe('mod+k');
    expect(screen.getByRole('alert')).toHaveTextContent('Find in thread');
    expect(screen.getByText('Press keys…')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'j', ctrlKey: true, metaKey: true });
    expect(loadBindings().commandPalette).toBe('mod+j');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reserves pane navigation shortcuts and allows cancelling without changing the binding', () => {
    render(<KeyboardShortcutsSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar shortcut' }));
    fireEvent.keyDown(window, { key: '1', ctrlKey: true, metaKey: true });
    expect(screen.getByRole('alert')).toHaveTextContent('pane');
    expect(loadBindings().toggleSidebar).toBe('mod+b');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(loadBindings().toggleSidebar).toBe('mod+b');
  });
});
