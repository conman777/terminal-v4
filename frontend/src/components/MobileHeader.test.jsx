import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { MobileHeader } from './MobileHeader';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn()
  })
}));

function buildProps(overrides = {}) {
  return {
    activeSessions: [{ id: 'session-1', title: 'Terminal 1', isBusy: false }],
    activeSessionId: 'session-1',
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    onRenameSession: vi.fn(),
    onCloseSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    keybarOpen: false,
    onToggleKeybar: vi.fn(),
    projects: [],
    projectsLoading: false,
    onFolderSelect: vi.fn(),
    currentPath: '',
    onAddScanFolder: vi.fn(),
    mobileView: 'terminal',
    onViewChange: vi.fn(),
    previewUrl: '',
    showFileManager: false,
    onToggleFileManager: vi.fn(),
    onNavigateToPath: vi.fn(),
    isNavCollapsed: false,
    sessionActivity: {},
    sessionsGroupedByProject: [],
    showTabStatusLabels: false,
    sessionAiTypes: {},
    onSetSessionAiType: vi.fn(),
    ...overrides
  };
}

describe('MobileHeader', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('opens the drawer on right swipe from the left edge', () => {
    const { container } = render(<MobileHeader {...buildProps()} />);
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    expect(screen.queryByRole('dialog', { name: /mobile menu/i })).not.toBeInTheDocument();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 10, clientY: 20 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 96, clientY: 22 }]
    });

    expect(screen.getByRole('dialog', { name: /mobile menu/i })).toBeInTheDocument();
  });

  it('toggles keybar on vertical swipe in terminal view', () => {
    const onToggleKeybar = vi.fn();
    const { container, rerender } = render(
      <MobileHeader {...buildProps({ keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 10 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 96 }]
    });
    expect(onToggleKeybar).toHaveBeenCalledTimes(1);

    rerender(<MobileHeader {...buildProps({ keybarOpen: true, onToggleKeybar })} />);
    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 92 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 12 }]
    });
    expect(onToggleKeybar).toHaveBeenCalledTimes(2);
  });

  it('does not toggle keybar when preview is active', () => {
    const onToggleKeybar = vi.fn();
    const { container } = render(
      <MobileHeader {...buildProps({ mobileView: 'preview', keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 12 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 98 }]
    });

    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('does not toggle keybar when conversation mode is active', () => {
    const onToggleKeybar = vi.fn();
    const { container } = render(
      <MobileHeader {...buildProps({ chatMode: true, keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 12 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 98 }]
    });

    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('shows the preview title instead of duplicate view tabs while preview is open', () => {
    const onViewChange = vi.fn();
    const { container } = render(
      <MobileHeader
        {...buildProps({
          mobileView: 'preview',
          previewUrl: 'https://example.com',
          onViewChange
        })}
      />
    );

    expect(container.querySelector('.mobile-header-title')).toHaveTextContent('Preview');
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to terminal' }));
    expect(onViewChange).toHaveBeenCalledWith('terminal');
  });

  it('ignores swipe gestures that start on interactive header controls', () => {
    const onToggleKeybar = vi.fn();
    render(<MobileHeader {...buildProps({ onToggleKeybar })} />);

    const menuButton = screen.getByRole('button', { name: /menu/i });

    fireEvent.touchStart(menuButton, {
      touches: [{ clientX: 10, clientY: 20 }]
    });
    fireEvent.touchEnd(menuButton, {
      changedTouches: [{ clientX: 96, clientY: 22 }]
    });

    expect(screen.queryByRole('dialog', { name: /mobile menu/i })).not.toBeInTheDocument();
    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('opens session picker when there are many sessions and jumps to selected session', () => {
    const onSelectSession = vi.fn();
    render(
      <MobileHeader
        {...buildProps({
          onSelectSession,
          activeSessions: [
            { id: 'session-1', title: 'Terminal 1', isBusy: false },
            { id: 'session-2', title: 'Terminal 2', isBusy: false },
            { id: 'session-3', title: 'Terminal 3', isBusy: false },
            { id: 'session-4', title: 'Terminal 4', isBusy: false }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /open session picker/i }));

    const picker = screen.getByRole('dialog', { name: /session picker/i });
    expect(picker).toBeInTheDocument();

    fireEvent.click(within(picker).getByRole('button', { name: /terminal 4/i }));
    expect(onSelectSession).toHaveBeenCalledWith('session-4');
  });

  it('shows a single active-session switcher instead of persistent session tabs', () => {
    const { container } = render(
      <MobileHeader
        {...buildProps({
          activeSessions: [
            { id: 'session-1', title: 'Terminal 1', isBusy: false, thread: { topic: 'explain this codebase' } },
            { id: 'session-2', title: 'Terminal 2', isBusy: false, thread: { topic: 'background terminal' } }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    expect(container.querySelector('.mobile-header-tabs-row')).toBeNull();
    const pickerButton = screen.getByRole('button', { name: /open session picker/i });
    expect(pickerButton).toBeInTheDocument();
    expect(within(pickerButton).getByText('explain this codebase')).toBeInTheDocument();
    expect(screen.queryByText('background terminal')).not.toBeInTheDocument();
  });

  it('opens the new terminal flow without forwarding the click event', () => {
    const onCreateSession = vi.fn();
    render(<MobileHeader {...buildProps({ onCreateSession })} />);

    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }));

    expect(onCreateSession).toHaveBeenCalledWith();
  });

  it('shows preferred thread topics in the session rail and seeds rename from the visible topic', () => {
    const onRenameSession = vi.fn();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('review upstream diff');

    render(
      <MobileHeader
        {...buildProps({
          onRenameSession,
          activeSessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              isBusy: false,
              thread: { topic: 'discard local changes' }
            }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    const pickerButton = screen.getByRole('button', { name: /open session picker/i });
    expect(within(pickerButton).getByText('discard local changes')).toBeInTheDocument();
    expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));

    expect(onRenameSession).toHaveBeenCalledWith('session-1', 'review upstream diff');
    promptSpy.mockRestore();
  });

  it('shows a compact project subtitle in the session rail instead of a raw path', () => {
    render(
      <MobileHeader
        {...buildProps({
          activeSessions: [
            {
              id: 'session-1',
              title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              isBusy: false,
              thread: { topic: 'ship the header polish' }
            }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    const pickerButton = screen.getByRole('button', { name: /open session picker/i });
    expect(within(pickerButton).getByText('uplifting')).toBeInTheDocument();
    expect(within(pickerButton).queryByText(/OneDrive/)).not.toBeInTheDocument();
  });

  it('shows busy state for the active session from shared session activity', () => {
    render(
      <MobileHeader
        {...buildProps({
          activeSessions: [
            {
              id: 'session-1',
              title: 'Current session',
              isBusy: false,
              thread: { topic: 'current session' }
            }
          ],
          activeSessionId: 'session-1',
          sessionActivity: {
            'session-1': {
              isBusy: true
            }
          }
        })}
      />
    );

    const pickerButton = screen.getByRole('button', { name: /open session picker/i });
    expect(pickerButton).toHaveClass('busy');
    expect(within(pickerButton).queryByText('Busy')).not.toBeInTheDocument();
    expect(within(pickerButton).getByText('current session')).toBeInTheDocument();
  });

  it('filters archived sessions out of the primary mobile controls', () => {
    render(
      <MobileHeader
        {...buildProps({
          activeSessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              isBusy: false,
              thread: { topic: 'visible one', archived: false }
            },
            {
              id: 'session-2',
              title: 'Terminal 2',
              isBusy: false,
              thread: { topic: 'visible two', archived: false }
            },
            {
              id: 'session-3',
              title: 'Terminal 3',
              isBusy: false,
              thread: { topic: 'visible three', archived: false }
            },
            {
              id: 'session-4',
              title: 'Terminal 4',
              isBusy: false,
              thread: { topic: 'archived thread', archived: true }
            }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /open session picker/i }));

    expect(screen.queryByText('archived thread')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /session picker/i })).toHaveTextContent('visible one');
  });

  it('opens file manager from the overflow menu without changing the active session', () => {
    const onToggleFileManager = vi.fn();
    const onSelectSession = vi.fn();

    render(
      <MobileHeader
        {...buildProps({
          onToggleFileManager,
          onSelectSession,
          activeSessions: [
            { id: 'session-1', title: 'Terminal 1', isBusy: false, thread: { topic: 'active thread' } }
          ],
          activeSessionId: 'session-1'
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'File Manager' }));

    expect(onToggleFileManager).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /open session picker/i })).toHaveTextContent('active thread');
  });

  it('does not offer preview from the header overflow when there is no preview URL', () => {
    render(<MobileHeader {...buildProps({ previewUrl: '' })} />);

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));

    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('offers preview from the header overflow when a preview URL exists', () => {
    const onViewChange = vi.fn();
    render(<MobileHeader {...buildProps({ previewUrl: 'https://example.com', onViewChange })} />);

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(onViewChange).toHaveBeenCalledWith('preview');
  });

  it('can hide preview and conversation-only navigation from the header', () => {
    render(
      <MobileHeader
        {...buildProps({
          previewUrl: 'https://example.com',
          showPreviewNavigation: false,
          showConversationToggle: false
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));

    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /conversation view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /terminal view/i })).not.toBeInTheDocument();
  });
});
