import { fireEvent, render, screen } from '@testing-library/react';
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
  it('dismisses the port picker with Escape and returns focus to its trigger', () => {
    const props = buildProps({ showPortDropdown: true, activePorts: [{ port: 4173, process: 'vite' }] });
    render(<PreviewUrlBar {...props} />);
    const search = screen.getByRole('textbox', { name: 'Filter active ports' });
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(props.onTogglePortDropdown).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Select active port' })).toHaveFocus();
  });

  it('distinguishes a filtered empty result from no detected ports', () => {
    render(<PreviewUrlBar {...buildProps({ showPortDropdown: true, activePorts: [{ port: 4173, process: 'vite' }] })} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter active ports' }), { target: { value: 'missing-app' } });
    expect(screen.getByRole('status')).toHaveTextContent('No ports match “missing-app”');
  });

  it.each([
    [{ supported: true, reason: null }, false],
    [{ supported: false, reason: 'Unsupported browser' }, true],
  ])('uses the support contract to enable WebContainer selection', (support, disabled) => {
    const props = buildProps({ showToolsMenu: true, webContainerSupported: support });
    render(<PreviewUrlBar {...props} />);
    const button = screen.getByRole('button', { name: 'Open WebContainer window' });
    if (disabled) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', support.reason);
    } else {
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(props.onToggleWebContainer).toHaveBeenCalledOnce();
    }
  });

  it('shows the active app badge when scope metadata is available', () => {
    render(
      <PreviewUrlBar
        {...buildProps({
          previewLoaded: true,
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

  it('labels an unloaded target as Project and disables an unavailable terminal split', () => {
    const props = buildProps({ activePreviewScope: { appLabel: 'unstarted-project' }, previewLoaded: false, hasTerminalSessions: false });
    render(<PreviewUrlBar {...props} />);
    expect(screen.getByLabelText('Project: unstarted-project')).toBeInTheDocument();
    expect(screen.queryByLabelText('Active app: unstarted-project')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Split', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Split', exact: true }));
    expect(props.onSetDesktopLayout).not.toHaveBeenCalled();
  });
});
