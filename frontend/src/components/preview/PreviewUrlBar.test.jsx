import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewUrlBar } from './PreviewUrlBar';

function buildProps(overrides = {}) {
  return {
    inputUrl: 'http://localhost:3020',
    onInputUrlChange: vi.fn(),
    activePorts: [],
    activePreviewScope: null,
    previewPort: null,
    showPortDropdown: false,
    onTogglePortDropdown: vi.fn(),
    portDropdownRef: { current: null },
    onSelectPort: vi.fn(),
    onUrlSubmit: vi.fn((event) => event.preventDefault()),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onRefresh: vi.fn(),
    historyIndex: 0,
    historyStackLength: 1,
    isLoading: false,
    iframeSrc: null,
    desktopLayoutMode: 'split',
    onSetDesktopLayout: vi.fn(),
    mobileViewportEnabled: false,
    onToggleMobileViewport: vi.fn(),
    useWebContainer: false,
    showDevTools: false,
    onToggleDevTools: vi.fn(),
    logCount: 0,
    showToolsMenu: false,
    onToggleToolsMenu: vi.fn(),
    toolsMenuRef: { current: null },
    inspectMode: false,
    onToggleInspect: vi.fn(),
    webContainerSupported: null,
    onToggleWebContainer: vi.fn(),
    onOpenExternal: vi.fn(),
    hasCookies: false,
    onClearCookies: vi.fn(),
    onClearCache: vi.fn(),
    previewModeInfo: null,
    compatibilityModeNotice: null,
    mainTerminalMinimized: false,
    onToggleMainTerminal: vi.fn(),
    alignTerminalControls: false,
    terminalAlignedWidth: 0,
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('PreviewUrlBar', () => {
  it('shows the active app badge when scope metadata is available', () => {
    render(
      <PreviewUrlBar
        {...buildProps({
          activePreviewScope: {
            appLabel: 'terminal v4',
            sessionLabel: 'Terminal 1',
            cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
          },
        })}
      />,
    );

    expect(screen.getByLabelText('Active app: terminal v4')).toBeInTheDocument();
    expect(screen.getByText('Active app')).toBeInTheDocument();
    expect(screen.getByText('terminal v4')).toBeInTheDocument();
  });
});
