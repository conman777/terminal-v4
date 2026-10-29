import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  it('finds commands and threads by name and runs the chosen one', () => {
    const newThread = vi.fn();
    const onSelectThread = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onSelectThread={onSelectThread}
      commands={[{ id: 'new-thread', label: 'New thread', run: newThread }, { id: 'settings', label: 'Open settings', run: vi.fn() }]}
      threads={[{ id: 't1', title: 'Fix login', project: 'web' }]} />);
    const search = screen.getByRole('combobox', { name: 'Search commands and threads' });
    fireEvent.change(search, { target: { value: 'login' } });
    const visible = screen.getAllByRole('option').map(option => option.textContent);
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.change(search, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('option', { name: /New thread/ }));
    expect([visible, onSelectThread.mock.calls, newThread.mock.calls.length, onClose.mock.calls.length]).toEqual([['Fix loginweb'], [['t1']], 1, 2]);
  });

  it('moves through results with the arrow keys and closes on Escape', () => {
    const second = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={[{ id: 'a', label: 'Alpha', run: vi.fn() }, { id: 'b', label: 'Beta', run: second }]} />);
    const search = screen.getByRole('combobox', { name: 'Search commands and threads' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect([second.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 2]);
  });
});
