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
    inactiveSessions: [],
    activeSessionId: 'session-1',
    onSelectSession: vi.fn(),
    onRestoreSession: vi.fn(),
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

  it('opens the new terminal flow without forwarding the click event', () => {
    const onCreateSession = vi.fn();
    render(<MobileHeader {...buildProps({ onCreateSession })} />);

    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }));

    expect(onCreateSession).toHaveBeenCalledWith();
  });
});
