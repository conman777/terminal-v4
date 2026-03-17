import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileShell } from './MobileShell';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('./Dropdown', () => ({
  Dropdown: ({ trigger }) => <div data-testid="dropdown-trigger">{trigger}</div>,
}));

vi.mock('./MobileDrawer', () => ({
  MobileDrawer: ({ isOpen, mobileView }) => (
    <div data-testid="mobile-drawer" data-open={isOpen ? 'true' : 'false'} data-view={mobileView} />
  ),
}));

vi.mock('./MobileSessionPicker', () => ({
  MobileSessionPicker: ({ isOpen }) => (
    <div data-testid="mobile-session-picker" data-open={isOpen ? 'true' : 'false'} />
  ),
}));

vi.mock('./MobileKeybar', () => ({
  MobileKeybar: ({ isOpen, sessionId }) => (
    <div data-testid="mobile-keybar" data-open={isOpen ? 'true' : 'false'} data-session-id={sessionId || ''} />
  ),
}));

vi.mock('./MobileTerminalSurface', () => ({
  MobileTerminalSurface: ({ session, onRegisterFocusTerminal }) => {
    onRegisterFocusTerminal?.(vi.fn());
    return <div data-testid="terminal-surface">{session?.id || 'none'}</div>;
  },
}));

function buildProps(overrides = {}) {
  return {
    activeSessions: [{ id: 'session-1', title: 'Terminal 1', isBusy: false }],
    activeSessionId: 'session-1',
    sessionActivity: {},
    sessionAiTypes: {},
    customAiProviders: [],
    projects: [],
    projectsLoading: false,
    currentPath: 'C:\\workspace',
    sessionsGroupedByProject: [],
    previewUrl: 'http://localhost:3000',
    projectInfo: { cwd: 'C:\\workspace', projectType: 'node', projectName: 'demo-app' },
    showFileManager: false,
    showStatusLabels: false,
    fontSize: 14,
    webglEnabled: false,
    viewportHeight: 700,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    onRenameSession: vi.fn(),
    onCloseSession: vi.fn(),
    onSetSessionAiType: vi.fn(),
    onAddCustomAiProvider: vi.fn(),
    onFolderSelect: vi.fn(),
    onAddScanFolder: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    onToggleFileManager: vi.fn(),
    onPreviewUrlChange: vi.fn(),
    onStartProject: vi.fn(),
    onSendToTerminal: vi.fn(),
    onSendToClaudeCode: vi.fn(),
    onUrlDetected: vi.fn(),
    onSessionBusyChange: vi.fn(),
    PreviewPanelComponent: ({ mobileShellMode }) => (
      <div data-testid="preview-panel">{mobileShellMode}</div>
    ),
    ...overrides,
  };
}

describe('MobileShell', () => {
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

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('switches surfaces and closes the keybar when entering preview mode', () => {
    render(<MobileShell {...buildProps()} />);

    expect(screen.getByTestId('terminal-surface')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-open', 'false');

    fireEvent.click(screen.getByRole('button', { name: /show keyboard bar/i }));
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /preview/i }));
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('preview-panel')).toHaveTextContent('integrated');
    expect(screen.queryByRole('tab', { name: /chat/i })).not.toBeInTheDocument();
  });

  it('falls back to terminal when preview is unavailable', () => {
    window.localStorage.setItem('mobileShellSurfaceV1', 'preview');

    render(<MobileShell {...buildProps({ previewUrl: '' })} />);

    expect(screen.getByTestId('terminal-surface')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /preview/i })).not.toBeInTheDocument();
  });
});
