import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionTab } from './SessionTab';

function buildProps(overrides = {}) {
  return {
    session: { id: 'session-1', title: 'Terminal 1' },
    isActive: false,
    hasUnread: false,
    isBusy: false,
    isReady: true,
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

  it('applies busy class when session is busy', () => {
    const { container } = render(<SessionTab {...buildProps({ isBusy: true, isReady: false })} />);

    expect(container.querySelector('.session-tab-item')?.className).toContain('busy');
  });

  it('shows idle status when not busy', () => {
    const { container } = render(<SessionTab {...buildProps({ isBusy: false })} />);

    expect(container.querySelector('.session-tab-item')?.className).not.toContain('busy');
    expect(container.querySelector('.tab-status-dot-modern')?.className).toContain('idle');
  });

  it('renders explicit status labels when enabled', () => {
    render(<SessionTab {...buildProps({ showStatusLabels: true, isBusy: true, isReady: false })} />);
    expect(screen.getByText('Busy')).toBeInTheDocument();
  });

  it('shows Idle label when not busy and status labels enabled', () => {
    render(<SessionTab {...buildProps({ showStatusLabels: true })} />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('renders provider metadata when aiType is available', () => {
    render(<SessionTab {...buildProps({ aiType: 'claude' })} />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('infers provider metadata from the session shell when aiType is not passed', () => {
    render(<SessionTab {...buildProps({ session: { id: 'session-1', title: 'Workspace', shell: 'codex' } })} />);

    expect(screen.getByText('Codex')).toBeInTheDocument();
  });
});
