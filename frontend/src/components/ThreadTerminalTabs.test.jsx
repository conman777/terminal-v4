import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadTerminalTabs } from './ThreadTerminalTabs';

const terminals = [{ id: 'a' }, { id: 'b' }];

describe('ThreadTerminalTabs', () => {
  it('without a panel does not point tabs at an element that does not exist', () => {
    render(<ThreadTerminalTabs terminals={terminals} selectedId="a" onSelect={vi.fn()} onAdd={vi.fn()} withPanels={false} />);
    expect(screen.getAllByRole('tab').map(tab => tab.hasAttribute('aria-controls'))).toEqual([false, false]);
  });

  it('offers split and close only when the owner supports them and disables every action together', () => {
    const { rerender } = render(<ThreadTerminalTabs terminals={terminals} selectedId="b" onSelect={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Split terminal' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
    const onClose = vi.fn();
    rerender(<ThreadTerminalTabs terminals={terminals} selectedId="b" onSelect={vi.fn()} onAdd={vi.fn()} onSplit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    expect(onClose).toHaveBeenCalledWith('b');
    rerender(<ThreadTerminalTabs terminals={terminals} selectedId="b" onSelect={vi.fn()} onAdd={vi.fn()} onSplit={vi.fn()} onClose={onClose} disabled />);
    expect(['New terminal in this thread', 'Split terminal', 'Close Terminal 2'].map(name => screen.getByRole('button', { name }).disabled)).toEqual([true, true, true]);
  });
});
