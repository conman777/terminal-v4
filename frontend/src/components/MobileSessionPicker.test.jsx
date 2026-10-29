import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileSessionPicker } from './MobileSessionPicker';

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    sessions: [
      {
        id: 'session-1',
        title: 'Terminal 5',
        updatedAt: '2026-03-09T10:00:00.000Z',
        isBusy: false,
        thread: { topic: 'discard local changes' }
      },
      {
        id: 'session-2',
        title: 'Terminal 6',
        updatedAt: '2026-03-09T10:01:00.000Z',
        isBusy: false,
        thread: { topic: 'this should only show this sho...' }
      }
    ],
    activeSessionId: 'session-1',
    sessionActivity: {},
    sessionAiTypes: {},
    onSelectSession: vi.fn(),
    ...overrides
  };
}

describe('MobileSessionPicker', () => {
  it('contains keyboard focus and returns it to the opener on dismissal', () => {
    const props = buildProps();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<MobileSessionPicker {...props} />);
    const close = screen.getByRole('button', { name: 'Close session picker' });
    const last = screen.getByRole('button', { name: /this should only show/i });
    expect(close).toHaveFocus();
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    view.rerender(<MobileSessionPicker {...props} isOpen={false} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('does not dismiss when a session list scroll ends in a downward swipe', () => {
    const props = buildProps();
    render(<MobileSessionPicker {...props} />);
    const session = screen.getByRole('button', { name: /discard local changes/i });
    fireEvent.touchStart(session, { touches: [{ clientX: 80, clientY: 100 }] });
    fireEvent.touchEnd(session, { changedTouches: [{ clientX: 80, clientY: 210 }] });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps search focus and its query when parent activity updates recreate callbacks', () => {
    const props = buildProps({ sessions: Array.from({ length: 7 }, (_, index) => ({ id: `session-${index}`, title: `Terminal ${index}` })) });
    const view = render(<MobileSessionPicker {...props} />);
    const search = screen.getByRole('textbox', { name: 'Search sessions' });
    search.focus();
    fireEvent.change(search, { target: { value: 'Terminal 2' } });
    view.rerender(<MobileSessionPicker {...props} onClose={vi.fn()} sessionActivity={{ 'session-2': { isBusy: true } }} />);
    expect(search).toHaveFocus();
    expect(search).toHaveValue('Terminal 2');
  });

  it('shows preferred thread topics instead of raw terminal titles', () => {
    render(<MobileSessionPicker {...buildProps()} />);

    expect(screen.getByText('discard local changes')).toBeInTheDocument();
    expect(screen.getByText('this should only show this sho...')).toBeInTheDocument();
    expect(screen.queryByText('Terminal 5')).not.toBeInTheDocument();
    expect(screen.queryByText('Terminal 6')).not.toBeInTheDocument();
  });

  it('filters sessions using the visible topic text', () => {
    render(<MobileSessionPicker {...buildProps({
      sessions: [
        {
          id: 'session-1',
          title: 'Terminal 1',
          updatedAt: '2026-03-09T10:00:00.000Z',
          isBusy: false,
          thread: { topic: 'discard local changes' }
        },
        {
          id: 'session-2',
          title: 'Terminal 2',
          updatedAt: '2026-03-09T10:01:00.000Z',
          isBusy: false,
          thread: { topic: 'review the api route' }
        },
        {
          id: 'session-3',
          title: 'Terminal 3',
          updatedAt: '2026-03-09T10:02:00.000Z',
          isBusy: false,
          thread: { topic: 'confirm mobile tabs' }
        },
        {
          id: 'session-4',
          title: 'Terminal 4',
          updatedAt: '2026-03-09T10:03:00.000Z',
          isBusy: false,
          thread: { topic: 'stage git changes' }
        },
        {
          id: 'session-5',
          title: 'Terminal 5',
          updatedAt: '2026-03-09T10:04:00.000Z',
          isBusy: false,
          thread: { topic: 'debug idle spinner' }
        },
        {
          id: 'session-6',
          title: 'Terminal 6',
          updatedAt: '2026-03-09T10:05:00.000Z',
          isBusy: false,
          thread: { topic: 'rename the terminal thread' }
        },
        {
          id: 'session-7',
          title: 'Terminal 7',
          updatedAt: '2026-03-09T10:06:00.000Z',
          isBusy: false,
          thread: { topic: 'launch codex in repo' }
        }
      ]
    })} />);

    fireEvent.change(screen.getByRole('textbox', { name: /search sessions/i }), {
      target: { value: 'spinner' }
    });

    expect(screen.getByText('debug idle spinner')).toBeInTheDocument();
    expect(screen.queryByText('discard local changes')).not.toBeInTheDocument();
  });

  it('uses shared session activity as the busy-state source of truth', () => {
    render(<MobileSessionPicker {...buildProps({
      sessionActivity: {
        'session-1': {
          isBusy: false
        },
        'session-2': {
          isBusy: true
        }
      }
    })} />);

    expect(screen.getByText('discard local changes').closest('.mobile-session-picker-item'))
      .not.toHaveTextContent('Busy');
    expect(screen.getByText('this should only show this sho...').closest('.mobile-session-picker-item'))
      .toContainElement(screen.getByLabelText('Working'));
  });

  it('hides archived sessions from the picker list', () => {
    render(<MobileSessionPicker {...buildProps({
      sessions: [
        {
          id: 'session-1',
          title: 'Terminal 5',
          updatedAt: '2026-03-09T10:00:00.000Z',
          isBusy: false,
          thread: { topic: 'discard local changes', archived: false }
        },
        {
          id: 'session-2',
          title: 'Terminal 6',
          updatedAt: '2026-03-09T10:01:00.000Z',
          isBusy: false,
          thread: { topic: 'archived work item', archived: true }
        }
      ]
    })} />);

    expect(screen.getByText('discard local changes')).toBeInTheDocument();
    expect(screen.queryByText('archived work item')).not.toBeInTheDocument();
  });

  it('shows compact project subtitles instead of raw paths', () => {
    render(<MobileSessionPicker {...buildProps({
      sessions: [
        {
          id: 'session-1',
          title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          updatedAt: '2026-03-09T10:00:00.000Z',
          isBusy: false,
          thread: { topic: 'discard local changes', archived: false }
        }
      ]
    })} />);

    expect(screen.getByText('uplifting')).toBeInTheDocument();
    expect(screen.queryByText(/OneDrive/)).not.toBeInTheDocument();
  });

  it('shows a ready indicator for inactive sessions with completed activity', () => {
    render(<MobileSessionPicker {...buildProps({
      activeSessionId: 'session-2',
      sessionActivity: {
        'session-1': {
          isBusy: false,
          needsAttention: true
        }
      }
    })} />);

    expect(screen.getByLabelText('Ready to review')).toBeInTheDocument();
  });
});
