import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Header } from './Header';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

function buildProps(overrides = {}) {
  return {
    isMobile: false,
    sessionProps: {
      activeSessions: [],
      inactiveSessions: [],
      activeSessionId: null,
      orderedSessions: [],
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
      onOpenSettings: vi.fn(),
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
    desktopSwitcherProps: {},
    mobileProps: {},
    ...overrides,
  };
}

describe('Header', () => {
  it('renders nothing for the desktop layout', () => {
    const { container } = render(<Header {...buildProps()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
