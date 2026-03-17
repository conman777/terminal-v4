import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel';

const previewUrlBarSpy = vi.fn();
const terminalChatSpy = vi.fn();
let activePortsResponse = [];
let isMobile = false;

vi.mock('../hooks/useMobileDetect', () => ({
  useMobileDetect: () => isMobile,
}));

vi.mock('../utils/auth', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
  })),
}));

vi.mock('../utils/webcontainer', () => ({
  isWebContainerSupported: vi.fn(async () => ({ supported: false, reason: 'disabled in test' })),
}));

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    enabled: true,
    setEnabled: vi.fn(),
    suggestions: [],
  }),
}));

vi.mock('./TerminalChat', () => ({
  TerminalChat: (props) => {
    terminalChatSpy(props);
    return <div data-testid={`terminal-chat-${props.sessionId}`} />;
  },
}));

vi.mock('./StyleEditor', () => ({
  StyleEditor: () => null,
}));

vi.mock('./devtools/DevToolsPanel', () => ({
  DevToolsPanel: () => null,
}));

vi.mock('./WebContainerPreview', () => ({
  WebContainerPreview: () => null,
}));

vi.mock('./preview/PreviewUrlBar', () => ({
  PreviewUrlBar: (props) => {
    previewUrlBarSpy(props);
    return <div data-testid="preview-url-bar" />;
  },
}));

vi.mock('./preview/PreviewInspector', () => ({
  PreviewInspector: () => null,
}));

function buildProps(overrides = {}) {
  return {
    url: null,
    onClose: vi.fn(),
    onUrlChange: vi.fn(),
    projectInfo: null,
    onStartProject: vi.fn(),
    onSendToTerminal: vi.fn(),
    onSendToClaudeCode: vi.fn(),
    activeSessions: [{
      id: 'session-1',
      title: 'Terminal 1',
      usesTmux: false,
    }],
    activeSessionId: 'session-1',
    sessionActivity: {},
    onSessionBusyChange: vi.fn(),
    fontSize: 14,
    webglEnabled: false,
    onUrlDetected: vi.fn(),
    mainTerminalMinimized: false,
    onToggleMainTerminal: vi.fn(),
    showStatusLabels: false,
    ...overrides,
  };
}

describe('PreviewPanel', () => {
  beforeEach(() => {
    previewUrlBarSpy.mockClear();
    terminalChatSpy.mockClear();
    isMobile = false;
    activePortsResponse = [{
      port: 8081,
      listening: true,
      previewed: false,
      previewable: true,
      probeStatus: 'html',
      reachable: true,
      frontendLikely: true,
      common: false,
      process: null,
      cwd: null,
    }];

    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes('/api/preview/active-ports')) {
        return {
          ok: true,
          json: async () => ({
            ports: activePortsResponse,
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({}),
      };
    }));

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 900,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn();
    }

    window.localStorage.clear();
  });

  it('shows previewable listening ports even when Windows metadata is missing', async () => {
    render(<PreviewPanel {...buildProps()} />);

    await waitFor(() => {
      const props = previewUrlBarSpy.mock.lastCall?.[0];
      expect(props).toBeTruthy();
      expect(props.activePorts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ port: 8081 }),
        ]),
      );
    });
  });

  it('falls back to active listening ports when no frontend probe match is available', async () => {
    activePortsResponse = [{
      port: 4173,
      listening: true,
      previewed: false,
      previewable: false,
      probeStatus: 'timeout',
      reachable: false,
      frontendLikely: false,
      common: false,
      process: null,
      cwd: null,
    }];

    render(<PreviewPanel {...buildProps()} />);

    await waitFor(() => {
      const props = previewUrlBarSpy.mock.lastCall?.[0];
      expect(props).toBeTruthy();
      expect(props.activePorts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ port: 4173 }),
        ]),
      );
    });
  });

  it('renders the desktop preview terminal in reader mirror mode', async () => {
    render(<PreviewPanel {...buildProps()} />);

    await waitFor(() => {
      const props = terminalChatSpy.mock.calls
        .map(([callProps]) => callProps)
        .find((callProps) => callProps.sessionId === 'session-1');

      expect(props).toBeTruthy();
      expect(props.syncPtySize).toBe(false);
      expect(props.viewMode).toBe('reader');
      expect(props.inputEnabled).toBe(false);
    });
  });

  it('keeps the mobile preview clean until terminal mode is explicitly selected', async () => {
    isMobile = true;

    render(<PreviewPanel {...buildProps()} />);

    expect(screen.queryByTestId('terminal-chat-session-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Debug' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close logs' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Console' }));

    expect(screen.getByRole('button', { name: 'Close logs' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));

    expect(await screen.findByTestId('terminal-chat-session-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch back to preview' }));

    await waitFor(() => {
      expect(screen.queryByTestId('terminal-chat-session-1')).not.toBeInTheDocument();
    });
  });
});
