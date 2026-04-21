import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Header } from './Header';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('./DesktopSwitcher', () => ({
  DesktopSwitcher: ({ desktops = [] }) => (
    <div data-testid="desktop-switcher">{desktops.map((desktop) => desktop.name).join(', ')}</div>
  )
}));

vi.mock('./SessionTabBar', () => ({
  SessionTabBar: ({ sessions = [] }) => (
    <div data-testid="session-tab-bar">{sessions.map((session) => session.title).join(', ')}</div>
  )
}));

function buildProps(overrides = {}) {
  return {
    isMobile: false,
    sessionProps: {
      activeSessions: [{ id: 'session-1', title: 'Review landing shell' }],
      inactiveSessions: [],
      activeSessionId: 'session-1',
      orderedSessions: [{ id: 'session-1', title: 'Review landing shell' }],
      onSelectSession: vi.fn(),
      onRestoreSession: vi.fn(),
      onCreateSession: vi.fn(),
      onCloseSession: vi.fn(),
      onRenameSession: vi.fn(),
      onReorderSessions: vi.fn(),
      loadingSessions: false,
      sessionLoadError: null,
      onRetryLoad: vi.fn(),
      sessionActivity: {},
      sessionsGroupedByProject: {},
      showTabStatusLabels: true,
      sessionAiTypes: {},
      onSetSessionAiType: vi.fn(),
    },
    modalProps: {
      setShowApiSettings: vi.fn(),
    desktopOnOpenSettings: vi.fn(),
      setShowBookmarks: vi.fn(),
      setShowNotes: vi.fn(),
      setShowProcessManager: vi.fn(),
    },
    showPreview: false,
    onTogglePreview: vi.fn(),
    showFileManager: false,
    onToggleFileManager: vi.fn(),
    showSystemResources: false,
    onToggleSystemResources: vi.fn(),
    user: { username: 'conor' },
    logout: vi.fn(),
    projectInfo: { cwd: 'C:\\Users\\conor\\code\\term-v4', gitBranch: 'main' },
    isSidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    desktopSwitcherProps: {
      desktops: [{ id: 'desktop-1', name: 'Workspace 1' }],
      activeDesktopId: 'desktop-1',
      sessions: [],
      onSwitch: vi.fn(),
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onMoveSession: vi.fn(),
    },
    mobileProps: {},
    ...overrides,
  };
}

describe('Header', () => {
  it('renders the desktop titlebar, workspace switcher, and session tabs', () => {
    render(<Header {...buildProps()} />);

    expect(screen.getByText(/term-v4/i)).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-switcher')).toHaveTextContent('Workspace 1');
    expect(screen.getByTestId('session-tab-bar')).toHaveTextContent('Review landing shell');
    expect(screen.getByRole('button', { name: /hide threads/i })).toBeInTheDocument();
  });
});
