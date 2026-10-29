import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';

vi.mock('./FolderBrowserModal', () => ({
  FolderBrowserModal: () => null,
}));

vi.mock('./AgentBrowserSettingsPanel', () => ({
  AgentBrowserSettingsPanel: () => <div>Agent browser test settings panel</div>,
}));
vi.mock('./McpSettingsPanel', () => ({
  McpSettingsPanel: () => <div>MCP test settings panel</div>,
}));
vi.mock('./ProviderConnectionsPanel', () => ({
  ProviderConnectionsPanel: () => <div>Provider connection test settings panel</div>,
}));

vi.mock('./AccountKnowledgePanel', () => ({
  AccountKnowledgePanel: () => <div>Account knowledge test settings panel</div>,
}));

vi.mock('../utils/auth', () => ({
  getAccessToken: () => null,
}));

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    sessionId: 'session-1',
    sessionTitle: 'Terminal 1',
    currentCwd: '/workspace',
    recentFolders: [],
    onSave: vi.fn(),
    onAddRecentFolder: vi.fn(),
    terminalFontSize: 14,
    onFontSizeChange: vi.fn(),
    terminalWebglEnabled: true,
    onWebglChange: vi.fn(),
    desktopAllowTerminalInput: false,
    onDesktopTerminalInputChange: vi.fn(),
    onOpenProcessManager: vi.fn(),
    showTabStatusLabels: true,
    onTabStatusLabelsChange: vi.fn(),
    ...overrides,
  };
}

function withNavigator(navigatorLike, testFn) {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: navigatorLike,
  });
  try {
    testFn();
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
}

describe('SettingsModal', () => {
  it('exposes the current settings section and selected toggle state', () => {
    render(<SettingsModal {...buildProps({ showTabStatusLabels: false })} />);
    expect(screen.getByRole('dialog', { name: 'Session Settings' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }));
    expect(screen.getByRole('button', { name: 'Workspace' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Interface' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Compact', pressed: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show', pressed: false })).toBeVisible();
  });
  it('opens system resources from process tooling', () => {
    const onOpenSystemResources = vi.fn();
    render(<SettingsModal {...buildProps({ onOpenSystemResources })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Processes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open System Resources' }));
    expect(onOpenSystemResources).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens agent settings panels only after selecting their sections', () => {
    render(<SettingsModal {...buildProps()} />);
    expect(screen.queryByText('MCP test settings panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Account knowledge test settings panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'MCP servers' }));
    expect(screen.getByText('MCP test settings panel')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done', exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/Changes are kept between sections.*Save before closing settings/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Account knowledge' }));
    expect(screen.getByText('MCP test settings panel')).not.toBeVisible();
    expect(screen.getByText('Account knowledge test settings panel')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Agent browser' }));
    expect(screen.getByText('Account knowledge test settings panel')).not.toBeVisible();
    expect(screen.getByText('Agent browser test settings panel')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Provider connections' }));
    expect(screen.getByText('Provider connection test settings panel')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done', exact: true })).not.toBeInTheDocument();
  });

  it('disables the WebGL renderer toggle on Linux desktops', () => {
    withNavigator(
      {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        platform: 'Linux x86_64',
      },
      () => {
        const onWebglChange = vi.fn();
        render(<SettingsModal {...buildProps({ onWebglChange })} />);
        fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

        const webglButton = screen.getByRole('button', { name: 'WebGL' });
        const canvasButton = screen.getByRole('button', { name: 'Canvas' });

        expect(webglButton).toBeDisabled();
        expect(canvasButton).toHaveClass('active');

        fireEvent.click(webglButton);
        expect(onWebglChange).not.toHaveBeenCalled();
        expect(
          screen.getByText(/disabled on linux desktops/i)
        ).toBeInTheDocument();
      }
    );
  });

  it('exposes the API settings path for Groq voice configuration', () => {
    const onOpenApiSettings = vi.fn();

    render(<SettingsModal {...buildProps({ onOpenApiSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Voice' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open API Settings' }));

    expect(onOpenApiSettings).toHaveBeenCalledTimes(1);
  });

  it('opens the process manager from settings', () => {
    const onOpenProcessManager = vi.fn();

    render(<SettingsModal {...buildProps({ onOpenProcessManager })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Processes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open Process Manager' }));

    expect(onOpenProcessManager).toHaveBeenCalledTimes(1);
  });

  it('switches desktop input mode between composer-only and terminal-enabled', () => {
    const onDesktopTerminalInputChange = vi.fn();

    render(<SettingsModal {...buildProps({ onDesktopTerminalInputChange, desktopAllowTerminalInput: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }));

    fireEvent.click(screen.getByRole('button', { name: 'Ask V4 + Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask V4 Only' }));

    expect(onDesktopTerminalInputChange).toHaveBeenNthCalledWith(1, true);
    expect(onDesktopTerminalInputChange).toHaveBeenNthCalledWith(2, false);
  });

  it('saves settings without navigating when the working directory is unchanged', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(<SettingsModal {...buildProps({ onSave, onClose, currentCwd: '/workspace' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates when the working directory changes', () => {
    const onSave = vi.fn();

    render(<SettingsModal {...buildProps({ onSave, currentCwd: '/workspace' })} />);

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/workspace-next' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' }));

    expect(onSave).toHaveBeenCalledWith('session-1', '/workspace-next');
  });
});
