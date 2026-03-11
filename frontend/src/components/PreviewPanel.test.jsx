import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel';

const previewUrlBarSpy = vi.fn();
const terminalChatSpy = vi.fn();

vi.mock('../hooks/useMobileDetect', () => ({
  useMobileDetect: () => false,
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

    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).includes('/api/preview/active-ports')) {
        return {
          ok: true,
          json: async () => ({
            ports: [{
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
            }],
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

  it('keeps the desktop preview terminal PTY-synced while the main terminal is visible', async () => {
    render(<PreviewPanel {...buildProps()} />);

    await waitFor(() => {
      const props = terminalChatSpy.mock.calls
        .map(([callProps]) => callProps)
        .find((callProps) => callProps.sessionId === 'session-1');

      expect(props).toBeTruthy();
      expect(props.syncPtySize).toBe(true);
    });
  });
});
