import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileDrawer } from './MobileDrawer';

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    projects: [],
    projectsLoading: false,
    onFolderSelect: vi.fn(),
    currentPath: '',
    onAddScanFolder: vi.fn(),
    onNavigateToPath: vi.fn(),
    mobileView: 'terminal',
    onViewChange: vi.fn(),
    previewUrl: '',
    activeSessions: [],
    activeSessionId: null,
    sessionActivity: {},
    onSelectSession: vi.fn(),
    sessionsGroupedByProject: [],
    ...overrides
  };
}

describe('MobileDrawer', () => {
  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(<MobileDrawer {...buildProps({ onClose })} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on left swipe gesture', () => {
    const onClose = vi.fn();
    const { container } = render(<MobileDrawer {...buildProps({ onClose })} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    fireEvent.touchStart(drawer, {
      touches: [{ clientX: 220, clientY: 120 }]
    });
    fireEvent.touchEnd(drawer, {
      changedTouches: [{ clientX: 140, clientY: 126 }]
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus within the drawer when tabbing', () => {
    const { container } = render(<MobileDrawer {...buildProps()} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const focusable = Array.from(drawer.querySelectorAll(selector));
    expect(focusable.length).toBeGreaterThan(1);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the previously focused element when closing', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open drawer';
    document.body.appendChild(trigger);
    trigger.focus();

    const props = buildProps({ isOpen: true });
    const { rerender } = render(<MobileDrawer {...props} />);

    rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(trigger).toHaveFocus();

    trigger.remove();
  });

  it('exposes dialog semantics while open', () => {
    render(<MobileDrawer {...buildProps()} />);

    expect(screen.getByRole('dialog', { name: /mobile menu/i })).toBeInTheDocument();
  });

  it('filters archived sessions from the live threads list', () => {
    render(<MobileDrawer {...buildProps({
      sessionsGroupedByProject: [
        {
          projectName: 'terminal-v4',
          projectPath: 'C:\\repo',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'visible thread', archived: false }
            },
            {
              id: 'session-2',
              title: 'Terminal 2',
              updatedAt: '2026-03-09T10:01:00.000Z',
              thread: { topic: 'archived thread', archived: true }
            }
          ]
        }
      ]
    })} />);

    expect(screen.getByText('visible thread')).toBeInTheDocument();
    expect(screen.queryByText('archived thread')).not.toBeInTheDocument();
  });

  it('shows the active session inside the threads section with derived labels', () => {
    render(<MobileDrawer {...buildProps({
      activeSessions: [
        {
          id: 'session-1',
          title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          updatedAt: '2026-03-09T10:00:00.000Z',
          thread: { topic: 'ship mobile header', archived: false }
        }
      ],
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'ship mobile header', archived: false }
            }
          ]
        }
      ],
      activeSessionId: 'session-1'
    })} />);

    expect(screen.getByText('Threads')).toBeInTheDocument();
    expect(screen.getAllByText('ship mobile header').length).toBeGreaterThan(0);
    expect(screen.getAllByText('uplifting').length).toBeGreaterThan(0);
  });

  it('surfaces primary utility actions from the simplified drawer', () => {
    const onOpenProcessManager = vi.fn();
    const onOpenBookmarks = vi.fn();
    const onOpenNotes = vi.fn();

    render(<MobileDrawer {...buildProps({ onOpenProcessManager, onOpenBookmarks, onOpenNotes })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Process Manager' }));
    expect(onOpenProcessManager).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));
    expect(onOpenBookmarks).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(onOpenNotes).toHaveBeenCalled();
  });

  it('shows compact session subtitles instead of raw paths in the live list', () => {
    render(<MobileDrawer {...buildProps({
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'ship mobile polish', archived: false }
            }
          ]
        }
      ]
    })} />);

    const upliftingLabels = screen.getAllByText('uplifting');
    expect(upliftingLabels.length).toBeGreaterThan(0);
    expect(screen.queryByText(/OneDrive/)).not.toBeInTheDocument();
  });

  it('does not render a recent terminals section', () => {
    render(<MobileDrawer {...buildProps()} />);

    expect(screen.queryByText('Recent terminals')).not.toBeInTheDocument();
  });

  it('does not render a separate current session hero card', () => {
    render(<MobileDrawer {...buildProps({
      activeSessions: [
        {
          id: 'session-1',
          title: 'Terminal 1',
          updatedAt: '2026-03-09T10:00:00.000Z',
          thread: { topic: 'active mobile thread', archived: false }
        }
      ],
      sessionsGroupedByProject: [
        {
          projectName: 'terminal-v4',
          projectPath: 'C:\\repo',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'active mobile thread', archived: false }
            }
          ]
        }
      ],
      activeSessionId: 'session-1'
    })} />);

    expect(screen.queryByText('Current session')).not.toBeInTheDocument();
    expect(screen.getByText('active mobile thread')).toBeInTheDocument();
  });

  it('renders the simplified drawer shell', () => {
    render(<MobileDrawer {...buildProps({ previewUrl: 'https://example.com' })} />);

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('does not render a preview button when no preview is available', () => {
    render(<MobileDrawer {...buildProps({ previewUrl: '' })} />);

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('switches to preview when a preview url is available', () => {
    const onViewChange = vi.fn();
    const onClose = vi.fn();

    render(<MobileDrawer {...buildProps({
      previewUrl: 'https://example.com',
      onViewChange,
      onClose,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(onViewChange).toHaveBeenCalledWith('preview');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a ready indicator for inactive threads with completed activity', () => {
    render(<MobileDrawer {...buildProps({
      activeSessionId: 'session-2',
      sessionActivity: {
        'session-1': {
          isBusy: false,
          needsAttention: true
        }
      },
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\repo\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'review mobile pass', archived: false }
            }
          ]
        }
      ]
    })} />);

    expect(screen.getByLabelText('Ready to review')).toBeInTheDocument();
  });
});
