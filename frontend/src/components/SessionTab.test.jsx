import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SessionTab } from './SessionTab';

function buildProps(overrides = {}) {
  return {
    session: { id: 'session-1', title: 'Terminal 1' },
    isActive: false,
    hasUnread: false,
    isBusy: false,
    isReady: true,
    isDone: false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onCloseOthers: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDrop: vi.fn(),
    onContextMenu: vi.fn(),
    ...overrides
  };
}

describe('SessionTab', () => {
  it('shows unread indicator only on inactive tabs', () => {
    const { container } = render(<SessionTab {...buildProps({ hasUnread: true })} />);

    expect(container.querySelector('.session-tab-item')?.className).toContain('has-unread');
    expect(container.querySelector('.tab-unread-dot-modern')).toBeInTheDocument();
  });

  it('hides unread indicator for the active tab', () => {
    const { container } = render(<SessionTab {...buildProps({ hasUnread: true, isActive: true })} />);

    expect(container.querySelector('.session-tab-item')?.className).not.toContain('has-unread');
    expect(container.querySelector('.tab-unread-dot-modern')).not.toBeInTheDocument();
  });

  it('applies done class when command completed in background', () => {
    const { container } = render(<SessionTab {...buildProps({ isDone: true })} />);

    expect(container.querySelector('.session-tab-item')?.className).toContain('done');
  });
});
