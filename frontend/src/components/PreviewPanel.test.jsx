import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewPanel } from './PreviewPanel';
import { resolveApiUrl } from '../utils/apiBase';
import { createWebContainerLaunch, getWebContainerLaunchSupport } from '../utils/webcontainerWindow';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { StorageTab } from './devtools/StorageTab';
import { clearTokens, setTokens, setUser } from '../utils/auth';

const MOBILE_VIEW_MODE_KEY = 'preview_mobile_view_mode_v1';
const MOBILE_SPLIT_ENABLED_KEY = 'preview_mobile_split_enabled_v1';
const previewUrlBarSpy = vi.fn();
const terminalChatSpy = vi.fn();
const devToolsSpy = vi.fn();
const resourceAuthMock = vi.fn();
const apiFetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({}),
}));
const uploadScreenshotMock = vi.fn();
let activePortsResponse = [];
let isMobile = false;
let configuredApiBase = '';

vi.mock('../utils/apiBase', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resolveApiUrl: path => actual.resolveApiUrl(path, configuredApiBase || undefined) };
});

vi.mock('../hooks/useMobileDetect', () => ({
  useMobileDetect: () => isMobile,
}));

vi.mock('../utils/auth', async importOriginal => ({
  ...await importOriginal(),
  getAccessToken: vi.fn(() => 'test-token'),
}));

vi.mock('../utils/api', () => ({
  apiFetch: (...args) => args[0] === '/api/preview/resource-auth' ? resourceAuthMock(...args) : apiFetchMock(...args),
  uploadScreenshot: (...args) => uploadScreenshotMock(...args),
}));

vi.mock('../utils/webcontainerWindow', () => ({
  getWebContainerLaunchSupport: vi.fn(() => ({ supported: false, reason: 'disabled in test' })),
  createWebContainerLaunch: vi.fn(),
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

vi.mock('./devtools/DevToolsPanel', () => ({
  DevToolsPanel: (props) => { devToolsSpy(props); return <StorageTab {...props} />; },
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
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    setActiveEnvironment(null);
    configuredApiBase = '';
    resourceAuthMock.mockReset().mockImplementation(async (_url, options) => {
      const target = new URL(options.body.targetPath, window.location.origin);
      if (['old-access-token', 'test-token'].includes(target.searchParams.get('token'))) target.searchParams.delete('token');
      target.searchParams.delete('previewToken');
      return { ok: true, json: async () => ({ previewToken: 'read-only-resource-ticket', targetPath: target.pathname + target.search + target.hash, expiresAt: 2000000000 }) };
    });
    getWebContainerLaunchSupport.mockReturnValue({ supported: false, reason: 'disabled in test' });
    devToolsSpy.mockClear();
    previewUrlBarSpy.mockClear();
    terminalChatSpy.mockClear();
    apiFetchMock.mockReset().mockImplementation(async input => ({
      ok: true,
      json: async () => String(input).includes('/api/preview/active-ports') ? { ports: activePortsResponse } : {},
    }));
    uploadScreenshotMock.mockReset();
    uploadScreenshotMock.mockResolvedValue('C:/tmp/preview image.png');
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
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
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

  async function prepareInspectorFrame(container) {
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    const iframe = container.querySelector('iframe');
    const post = vi.spyOn(iframe.contentWindow, 'postMessage');
    fireEvent.load(iframe);
    return { iframe, epoch: post.mock.calls.findLast(([message]) => message.type === 'preview-parent-ready')?.[0].previewEpoch };
  }

  it.each([false, true])('retains the actual iframe, form, client state and scroll at expiry until explicit reconnect on mobile=%s', async mobile => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-25T12:00:00Z'));
    isMobile = mobile;
    let grants = 0;
    resourceAuthMock.mockImplementation(async (_path, options) => ({ ok: true, json: async () => ({ targetPath: options.body.targetPath, previewToken: `retained-${++grants}`, expiresAt: Date.now() / 1000 + 5 }) }));
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/form' })} />);
    await act(async () => {});
    const frame = container.querySelector('iframe');
    const originalUrl = frame.src;
    frame.contentDocument.open(); frame.contentDocument.write('<form><input aria-label="Unsaved preview draft"></form>'); frame.contentDocument.close();
    const draft = frame.contentDocument.querySelector('input'); draft.value = 'Keep this unsaved form';
    frame.contentWindow.syntheticState = 'retained client state';
    frame.contentDocument.documentElement.scrollTop = 84;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.src).toBe(originalUrl);
    expect([draft.isConnected, draft.value, frame.contentWindow.syntheticState, frame.contentDocument.documentElement.scrollTop]).toEqual([true, 'Keep this unsaved form', 'retained client state', 84]);
    expect(resourceAuthMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Preview connection expired' })).toHaveTextContent('Unsaved changes may be lost');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect preview' }));
    await act(async () => {});
    expect(container.querySelector('iframe')).not.toBe(frame);
    expect(resourceAuthMock).toHaveBeenCalledTimes(2);
  });

  it.each(['evaluate', 'storage'])('blocks %s before preflight and after a preflight that crosses expiry', async operation => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-25T12:00:00Z'));
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    resourceAuthMock.mockImplementation(async (_path, options) => ({ ok: true, json: async () => ({ targetPath: options.body.targetPath, previewToken: 'deadline-grant', expiresAt: Date.now() / 1000 + 5 }) }));
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/form' })} />);
    await act(async () => {});
    const frame = container.querySelector('iframe');
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    let finish;
    apiFetchMock.mockImplementation(async path => path.endsWith('/client-operation') ? new Promise(resolve => { finish = resolve; }) : { ok: true, json: async () => ({}) });
    const invoke = () => operation === 'evaluate' ? devToolsSpy.mock.lastCall[0].onEvaluate('document.title') : devToolsSpy.mock.lastCall[0].onUpdateStorage('localStorage', 'set', 'draft', 'value');
    let pending;
    act(() => { pending = invoke().catch(error => error); });
    expect(finish).toBeTypeOf('function');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await act(async () => finish({ ok: true }));
    expect(await pending).toBeInstanceOf(Error);
    expect(post.mock.calls.filter(([message]) => ['preview-evaluate', 'preview-storage-operation'].includes(message.type))).toEqual([]);
    const requests = apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/client-operation')).length;
    await expect(invoke()).rejects.toThrow(/expired/i);
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/client-operation'))).toHaveLength(requests);
    expect(container.querySelector('iframe')).toBe(frame);
  });

  it.each([false, true])('uses a neutral empty project, no empty terminal split and an explicit terminal CTA on mobile=%s', async mobile => {
    isMobile = mobile;
    activePortsResponse = [];
    const openTerminal = vi.fn();
    const { container } = render(<PreviewPanel {...buildProps({ activeSessions: [], activeSessionId: null, projectInfo: { cwd: '/synthetic/unstarted-project', projectType: 'unknown' }, onOpenTerminal: openTerminal })} />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'No URL' })).toBeInTheDocument();
    expect(container.querySelector('.preview-terminal-section')).toBeNull();
    expect(container.textContent).not.toContain('Active app:');
    expect(container.textContent).not.toContain('C:\\path\\to\\project');
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal', exact: true }));
    expect(openTerminal).toHaveBeenCalledOnce();
    expect(openTerminal).toHaveBeenCalledWith();
    if (!mobile) expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ previewLoaded: false, browserSplitEnabled: false });
  });

  it.each(['target', 'auth', 'environment', 'unmount'])('retires a retained expired document when %s changes', async kind => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-25T12:00:00Z'));
    clearTokens(true); setTokens('retention-owner-access', 'retention-owner-refresh'); setUser({ id: 'retention-owner', username: 'fixture' });
    resourceAuthMock.mockImplementation(async (_path, options) => ({ ok: true, json: async () => ({ targetPath: options.body.targetPath, previewToken: 'retirement-grant', expiresAt: Date.now() / 1000 + 5 }) }));
    const props = buildProps({ url: '/preview/4173/form' });
    const view = render(<PreviewPanel {...props} />);
    await act(async () => {});
    const frame = view.container.querySelector('iframe');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(view.container.querySelector('iframe')).toBe(frame);
    resourceAuthMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      if (kind === 'target') view.rerender(<PreviewPanel {...props} url="/preview/5173/new" />);
      else if (kind === 'auth') setTokens('replacement-access', 'replacement-refresh');
      else if (kind === 'environment') setActiveEnvironment({ id: 'retention-paired-fixture' });
      else view.unmount();
    });
    await act(async () => {});
    expect(frame.isConnected).toBe(false);
    expect(screen.queryByRole('status', { name: 'Preview connection expired' })).not.toBeInTheDocument();
  });

  it.each([false, true])('offers a cross-platform terminal path without a project on mobile=%s', async mobile => {
    isMobile = mobile; activePortsResponse = [];
    const openTerminal = vi.fn();
    render(<PreviewPanel {...buildProps({ activeSessions: [], activeSessionId: null, onOpenTerminal: openTerminal })} />);
    await act(async () => {});
    expect(screen.getByText('Enter a URL or an absolute path to an HTML file on this server.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal', exact: true }));
    expect(openTerminal).toHaveBeenCalledWith();
  });

  it('labels a project neutrally through loading/error and only marks it active after a load', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app', projectInfo: { cwd: '/synthetic/project', projectType: 'unknown' } })} />);
    expect(previewUrlBarSpy.mock.lastCall[0].previewLoaded).toBe(false);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    await act(async () => {});
    fireEvent.load(container.querySelector('iframe'));
    expect(previewUrlBarSpy.mock.lastCall[0].previewLoaded).toBe(true);
    fireEvent.error(container.querySelector('iframe'));
    expect(previewUrlBarSpy.mock.lastCall[0].previewLoaded).toBe(false);
  });

  it('retains back and forward entries while waiting for the parent URL update', async () => {
    const first = '/preview/4173/first', second = '/preview/4173/second', third = '/preview/4173/third';
    const props = buildProps({ url: first });
    const { rerender } = render(<PreviewPanel {...props} />);
    rerender(<PreviewPanel {...props} url={second} />);
    rerender(<PreviewPanel {...props} url={third} />);
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 2, historyStackLength: 3 });
    act(() => previewUrlBarSpy.mock.lastCall[0].onBack());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith(second));
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 1, historyStackLength: 3 });
    rerender(<PreviewPanel {...props} url={second} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onBack());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith(first));
    rerender(<PreviewPanel {...props} url={first} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onForward());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith(second));
    rerender(<PreviewPanel {...props} url={second} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onForward());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith(third));
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 2, historyStackLength: 3 });
  });

  it('replaces forward history when a new URL is entered after going back', async () => {
    const props = buildProps({ url: '/preview/4173/first' });
    const { rerender } = render(<PreviewPanel {...props} />);
    rerender(<PreviewPanel {...props} url="/preview/4173/second" />);
    rerender(<PreviewPanel {...props} url="/preview/4173/third" />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onBack());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith('/preview/4173/second'));
    rerender(<PreviewPanel {...props} url="/preview/4173/second" />);
    rerender(<PreviewPanel {...props} url="/preview/4173/replacement" />);
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 2, historyStackLength: 3 });
    props.onUrlChange.mockClear();
    act(() => previewUrlBarSpy.mock.lastCall[0].onForward());
    expect(props.onUrlChange).not.toHaveBeenCalled();
    act(() => previewUrlBarSpy.mock.lastCall[0].onBack());
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith('/preview/4173/second'));
  });

  it.each([false, true])('keeps preview shortcuts inside its pane and synchronizes inspector Escape on mobile=%s', async mobile => {
    isMobile = mobile;
    const { container } = render(<><button>Outside preview</button><PreviewPanel {...buildProps({ url: '/preview/4173/app' })} /></>);
    const { iframe } = await prepareInspectorFrame(container);
    const post = vi.mocked(iframe.contentWindow.postMessage);
    const outside = screen.getByRole('button', { name: 'Outside preview' });
    act(() => outside.focus());
    fireEvent.keyDown(outside, { key: 'i', ctrlKey: true });
    expect(post.mock.calls.filter(([message]) => message.type === 'preview-inspect-mode')).toEqual([]);
    const panel = container.querySelector('.preview-panel');
    act(() => outside.blur());
    fireEvent.keyDown(panel, { key: 'i', ctrlKey: true });
    expect(post).toHaveBeenLastCalledWith({ type: 'preview-inspect-mode', enabled: true }, '*');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(post).toHaveBeenLastCalledWith({ type: 'preview-inspect-mode', enabled: false }, '*');
  });

  it('allows keyboard adjustment of the terminal split and DevTools size', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const split = screen.getByRole('separator', { name: 'Resize preview and terminal' });
    expect(split).toHaveAttribute('aria-valuenow', '68');
    fireEvent.keyDown(split, { key: 'ArrowLeft' });
    expect(split).toHaveAttribute('aria-valuenow', '63');
    expect(container.querySelector('.preview-iframe-section').style.flex).toBe('0 0 63%');
    fireEvent.keyDown(split, { key: 'End' });
    expect(split).toHaveAttribute('aria-valuenow', '90');
    fireEvent.click(screen.getByTitle('Move terminal to left'));
    fireEvent.keyDown(split, { key: 'ArrowRight' });
    expect(split).toHaveAttribute('aria-valuenow', '85');
    act(() => previewUrlBarSpy.mock.lastCall[0].onToggleDevTools());
    const devTools = screen.getByRole('separator', { name: 'Resize DevTools' });
    const previous = Number(devTools.getAttribute('aria-valuenow'));
    fireEvent.keyDown(devTools, { key: 'ArrowUp' });
    expect(devTools).toHaveAttribute('aria-valuenow', String(previous + 20));
    fireEvent.keyDown(devTools, { key: 'Home' });
    expect(container.querySelector('.preview-logs').style.height).toBe('140px');
  });

  it.each([false, true])('recovers from an iframe load error when navigating to another URL on mobile=%s', async mobile => {
    isMobile = mobile;
    const props = buildProps({ url: '/preview/4173/unavailable' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    fireEvent.error(container.querySelector('iframe'));
    expect(await screen.findByText('Load Error')).toBeInTheDocument();
    rerender(<PreviewPanel {...props} url="/preview/5173/working" />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('/preview/5173/working'));
    expect(screen.queryByText('Load Error')).not.toBeInTheDocument();
  });

  it('keeps the mobile preview document and its state mounted while viewing a terminal', async () => {
    isMobile = true;
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(iframe).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(iframe).toBeVisible();
  });

  it('does not add history for proxy location reporting or reload cache-busters', async () => {
    const props = buildProps({ url: '/preview/4173/app?theme=blue#details' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    let { iframe } = await prepareInspectorFrame(container);
    const report = value => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-location', url: value } }));
    act(() => report('http://localhost:4173/app?theme=blue#details'));
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(props.onUrlChange).not.toHaveBeenCalled();
    act(() => report('http://localhost:4173/next?theme=blue'));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenLastCalledWith('http://localhost:4173/next?theme=blue'));
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onRefresh());
    ({ iframe } = await prepareInspectorFrame(container));
    props.onUrlChange.mockClear();
    act(() => report('http://localhost:4173/next?theme=blue&_cb=123&previewToken=fixture'));
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(props.onUrlChange).not.toHaveBeenCalled();
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 1, historyStackLength: 2 });
    act(() => previewUrlBarSpy.mock.lastCall[0].onBack());
    expect(props.onUrlChange).toHaveBeenLastCalledWith('/preview/4173/app?theme=blue#details');
  });

  it('prevents duplicate pending composer sends and preserves newer text and attachments', async () => {
    const user = userEvent.setup();
    let finishSend;
    const { container } = render(<PreviewPanel {...buildProps()} />);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    await user.type(composer, 'submitted draft');
    apiFetchMock.mockImplementation(async (path) => path.endsWith('/input') ? new Promise(resolve => { finishSend = resolve; }) : { ok: true, json: async () => ({}) });
    const send = screen.getByRole('button', { name: 'Send to terminal' });
    await user.click(send);
    await waitFor(() => expect(finishSend).toBeTypeOf('function'));
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest('form'));
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input'))).toHaveLength(1);
    await user.clear(composer);
    await user.type(composer, 'newer unsent draft');
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await user.upload(container.querySelector('.status-composer-image-input'), new File(['new image'], 'new.png', { type: 'image/png' }));
    await screen.findByRole('button', { name: /Remove.*new.png/ });
    await act(async () => finishSend({ ok: true }));
    expect(composer).toHaveValue('newer unsent draft');
    expect(screen.getByRole('button', { name: /Remove.*new.png/ })).toBeInTheDocument();
    expect(send).toBeEnabled();
  });

  it('does not clear the composer in another session when an earlier send completes', async () => {
    const user = userEvent.setup();
    let finishSend;
    render(<PreviewPanel {...buildProps({ activeSessions: [{ id: 'session-1', title: 'First terminal' }, { id: 'session-2', title: 'Second terminal' }] })} />);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    await user.type(composer, 'submitted draft');
    apiFetchMock.mockImplementation(async path => path.endsWith('/input') ? new Promise(resolve => { finishSend = resolve; }) : { ok: true, json: async () => ({}) });
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));
    await user.click(screen.getByRole('button', { name: 'Second terminal' }));
    await act(async () => finishSend({ ok: true }));
    expect(composer).toHaveValue('submitted draft');
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input')).map(([path]) => path)).toEqual(['/api/terminal/session-1/input']);
  });

  it('removes the stale desktop terminal and composer when the last session closes', async () => {
    const props = buildProps();
    const { rerender } = render(<PreviewPanel {...props} />);
    await screen.findByTestId('terminal-chat-session-1');
    rerender(<PreviewPanel {...props} activeSessions={[]} activeSessionId={null} />);
    expect(screen.queryByTestId('terminal-chat-session-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Command composer' })).not.toBeInTheDocument();
  });

  it('toggles mobile sheets with their triggers and restores focus with Escape from a sheet input', async () => {
    isMobile = true;
    const user = userEvent.setup();
    render(<PreviewPanel {...buildProps()} />);
    const portButton = screen.getByRole('button', { name: 'Select port' });
    await user.click(portButton);
    const search = await screen.findByRole('textbox', { name: 'Filter active ports' });
    await user.click(search);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Filter active ports' })).not.toBeInTheDocument();
    expect(portButton).toHaveFocus();
    await user.click(portButton);
    await screen.findByRole('textbox', { name: 'Filter active ports' });
    await user.click(portButton);
    expect(screen.queryByRole('textbox', { name: 'Filter active ports' })).not.toBeInTheDocument();
    const toolsButton = screen.getByRole('button', { name: 'More tools' });
    await user.click(toolsButton);
    expect(screen.getByRole('button', { name: 'Inspect Element' })).toBeInTheDocument();
    await user.click(toolsButton);
    expect(screen.queryByRole('button', { name: 'Inspect Element' })).not.toBeInTheDocument();
    await user.click(toolsButton);
    await user.click(screen.getByRole('button', { name: 'Console' }));
    expect(screen.getByRole('button', { name: 'Close logs' })).toBeInTheDocument();
  });

  it('rejects a denied console evaluation before executing in the iframe and permits retry', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    const post = vi.mocked(iframe.contentWindow.postMessage);
    apiFetchMock.mockImplementation(async path => ({ ok: !path.endsWith('/client-operation'), json: async () => ({}) }));
    await expect(devToolsSpy.mock.lastCall[0].onEvaluate('document.title')).rejects.toThrow('could not accept');
    expect(post.mock.calls.filter(([message]) => message.type === 'preview-evaluate')).toEqual([]);
    apiFetchMock.mockResolvedValue({ ok: true });
    await devToolsSpy.mock.lastCall[0].onEvaluate('document.title');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/client-operation', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ kind: 'evaluate', expression: 'document.title' }),
    }));
    expect(post).toHaveBeenLastCalledWith({ type: 'preview-evaluate', expression: 'document.title' }, '*');
  });

  it('authorizes frame-local storage without claiming a server-side storage mutation', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue({ ok: true });
    await act(async () => devToolsSpy.mock.lastCall[0].onUpdateStorage('localStorage', 'set', 'synthetic', 'value'));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/client-operation', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ kind: 'storage', storage: { type: 'localStorage', operation: 'set', key: 'synthetic', value: 'value' } }),
    }));
    expect(apiFetchMock.mock.calls.some(([path]) => path.endsWith('/storage'))).toBe(false);
    expect(iframe.contentWindow.postMessage).toHaveBeenLastCalledWith({ type: 'preview-storage-operation', storageType: 'localStorage', operation: 'set', key: 'synthetic', value: 'value' }, '*');
  });

  it('does not dispatch an old storage authorization into a replacement preview document', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    let finishAuthorization;
    apiFetchMock.mockImplementation(async path => path.endsWith('/client-operation')
      ? new Promise(resolve => { finishAuthorization = resolve; })
      : { ok: true, json: async () => ({}) });
    let write;
    act(() => { write = devToolsSpy.mock.lastCall[0].onUpdateStorage('localStorage', 'set', 'synthetic', 'old-document-value'); });
    await waitFor(() => expect(finishAuthorization).toBeTypeOf('function'));
    fireEvent.load(iframe);
    await act(async () => { finishAuthorization({ ok: true }); await write; });
    expect(iframe.contentWindow.postMessage.mock.calls.filter(([message]) => message.type === 'preview-storage-operation')).toEqual([]);
  });

  it('retires an in-flight cookie edit when the same preview document is replaced', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    let finishWrite;
    apiFetchMock.mockImplementation(async (path, options) => {
      if (path.endsWith('/storage') && options?.method === 'POST') return new Promise(resolve => { finishWrite = resolve; });
      return { ok: true, json: async () => path.endsWith('/cookies') ? { cookies: [{ name: 'session', value: 'current-cookie' }] } : {} };
    });
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    let write;
    act(() => { write = devToolsSpy.mock.lastCall[0].onUpdateStorage('cookies', 'set', 'session', 'old-document-edit'); });
    await waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    fireEvent.load(iframe);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-cookie' }));
    const reads = apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/cookies')).length;
    await act(async () => { finishWrite({ ok: true }); await write; });
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/cookies'))).toHaveLength(reads);
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-cookie' });
  });

  it('restarts cookie polling for a replacement document on the same URL', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    let cookie = 'before-reload';
    apiFetchMock.mockImplementation(async path => ({ ok: true, json: async () => path.endsWith('/cookies') ? { cookies: [{ name: 'session', value: cookie }] } : {} }));
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'before-reload' }));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    cookie = 'after-reload';
    fireEvent.load(container.querySelector('iframe'));
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'after-reload' }));
  });

  it('retains the pending-send guard when returning to a terminal with an unresolved submission', async () => {
    const user = userEvent.setup();
    let finishSend;
    render(<PreviewPanel {...buildProps({ activeSessions: [{ id: 'session-1', title: 'First terminal' }, { id: 'session-2', title: 'Second terminal' }] })} />);
    await user.type(screen.getByRole('textbox', { name: 'Command composer' }), 'pending command');
    apiFetchMock.mockImplementation(async path => path.endsWith('/input') ? new Promise(resolve => { finishSend = resolve; }) : { ok: true, json: async () => ({}) });
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));
    await user.click(screen.getByRole('button', { name: 'Second terminal' }));
    await user.click(screen.getByRole('button', { name: 'First terminal' }));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Send to terminal' }).closest('form'));
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input'))).toHaveLength(1);
    await act(async () => finishSend({ ok: true }));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('');
  });

  it('keeps inspector-enabled reload flags out of the visible URL and history', async () => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container } = render(<PreviewPanel {...props} />);
    await prepareInspectorFrame(container);
    act(() => previewUrlBarSpy.mock.lastCall[0].onToggleInspect());
    act(() => previewUrlBarSpy.mock.lastCall[0].onRefresh());
    const { iframe } = await prepareInspectorFrame(container);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-location', url: 'http://localhost:4173/app?__inspect=1&_cb=123' } })));
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(props.onUrlChange).not.toHaveBeenCalled();
    expect(previewUrlBarSpy.mock.lastCall[0]).toMatchObject({ historyIndex: 0, historyStackLength: 1 });
  });

  it('preserves isolated-window launch support for the browser tools menu', async () => {
    const support = { supported: true, reason: null };
    getWebContainerLaunchSupport.mockReturnValue(support);
    render(<PreviewPanel {...buildProps()} />);
    await waitFor(() => expect(previewUrlBarSpy.mock.lastCall[0].webContainerSupported).toEqual(support));
  });

  it('opens a noopener isolated window without replacing the current proxy and offers a real fallback link', async () => {
    const launch = { id: 'a'.repeat(32), href: '/webcontainer#' + 'a'.repeat(32), ready: Promise.resolve() };
    createWebContainerLaunch.mockReturnValueOnce(launch);
    getWebContainerLaunchSupport.mockReturnValue({ supported: true, reason: null });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/project', projectInfo: { cwd: '/synthetic/project', startCommand: 'npm run serve' } })} />);
      await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
      const iframe = container.querySelector('iframe');
      const original = { src: iframe.getAttribute('src'), sandbox: iframe.getAttribute('sandbox') };
      await act(async () => previewUrlBarSpy.mock.lastCall[0].onToggleWebContainer());
      expect(open).toHaveBeenCalledWith(launch.href, '_blank', 'noopener,noreferrer');
      expect(createWebContainerLaunch).toHaveBeenCalledWith({ projectPath: '/synthetic/project', startCommand: 'npm run serve' });
      expect({ src: iframe.getAttribute('src'), sandbox: iframe.getAttribute('sandbox') }).toEqual(original);
      expect(screen.getByRole('link', { name: 'open the WebContainer window' })).toHaveAttribute('href', launch.href);
      expect(previewUrlBarSpy.mock.lastCall[0].useWebContainer).toBe(false);
    } finally { open.mockRestore(); }
  });

  it('explains why WebContainer mode is unavailable on a paired host', async () => {
    getWebContainerLaunchSupport.mockReturnValue({ supported: true, reason: null });
    setActiveEnvironment({ id: 'paired-host' });
    render(<PreviewPanel {...buildProps()} />);
    await waitFor(() => expect(previewUrlBarSpy.mock.lastCall[0].webContainerSupported).toEqual({
      supported: false,
      reason: 'WebContainers run in this browser and cannot access a paired host project.',
    }));
  });

  it.each([
    '/preview/4173/app',
    '/api/environments/paired-host/proxy/preview/4173/app',
  ])('enables port tools and cookie inspection for %s', async url => {
    let cookies = [{ name: 'session', value: 'preview-session', path: '/', domain: null }];
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'DELETE') cookies = [];
      return { ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies, hasCookies: cookies.length > 0 } : {} };
    });
    render(<PreviewPanel {...buildProps({ url })} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/cookies', expect.any(Object)));
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0]).toMatchObject({
      previewPort: 4173,
      storage: { cookies: { session: 'preview-session' } },
    }));
    expect(previewUrlBarSpy.mock.lastCall[0].hasCookies).toBe(true);
    await act(async () => previewUrlBarSpy.mock.lastCall[0].onClearCookies());
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({});
  });

  it('edits and removes proxy cookies through the server jar while browser storage is isolated', async () => {
    const user = userEvent.setup();
    let cookies = [{ name: 'session', value: 'original' }];
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/storage') && options?.method === 'POST') {
        const update = JSON.parse(options.body);
        if (update.operation === 'set') cookies = [{ name: update.key, value: update.value }];
        if (update.operation === 'remove') cookies = [];
      }
      return { ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies, hasCookies: cookies.length > 0 } : {} };
    });
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'original' }));
    const { iframe: frame } = await prepareInspectorFrame(container);
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: {
      type: 'preview-storage-sync', port: 4173, local: {}, session: {},
      available: { localStorage: false, sessionStorage: false },
    } }));
    expect(screen.getByRole('status')).toHaveTextContent('Browser storage is unavailable');
    await user.click(screen.getByRole('button', { name: /Cookies/ }));
    expect(screen.queryByText('Browser storage is unavailable', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText('original')).toBeInTheDocument();
    await user.click(screen.getByTitle('Edit'));
    await user.clear(container.querySelector('.edit-input'));
    await user.type(container.querySelector('.edit-input'), 'updated');
    await user.click(screen.getByTitle('Save'));
    expect(await screen.findByText('updated')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/storage', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ type: 'cookies', operation: 'set', key: 'session', value: 'updated' }),
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByTitle('Delete'));
    expect(await screen.findByText('No cookies items')).toBeInTheDocument();
    expect(previewUrlBarSpy.mock.lastCall[0].hasCookies).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'preview-storage-operation', storageType: 'cookies' }), '*');
    confirm.mockRestore();
  });

  it('preserves the paired route when the preview iframe loads', async () => {
    const url = '/api/environments/paired-host/proxy/preview/4173/app';
    const { container } = render(<PreviewPanel {...buildProps({ url })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const frame = container.querySelector('iframe');
    fireEvent.load(frame);
    expect(new URL(frame.src).pathname).toBe(url);
    expect(previewUrlBarSpy.mock.lastCall[0].previewModeInfo.id).toBe('path-compat');
  });

  it('drops cookie snapshots when switching to a preview without a port', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ cookies: [{ name: 'session', value: 'private' }], hasCookies: true }) });
    const { rerender } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'private' }));
    rerender(<PreviewPanel {...buildProps({ url: 'https://example.org' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({}));
    expect(previewUrlBarSpy.mock.lastCall[0].hasCookies).toBe(false);
  });

  it.each(['set', 'remove', 'clear'])('does not let an older cookie snapshot overwrite a completed %s operation', async operation => {
    const user = userEvent.setup();
    let finishOldRead;
    let blockNextRead = false;
    let updated = false;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/storage') && options?.method === 'POST') updated = true;
      if (String(input).endsWith('/cookies') && blockNextRead) {
        blockNextRead = false;
        return new Promise(resolve => { finishOldRead = () => resolve({ ok: true, json: async () => ({ cookies: [{ name: 'session', value: 'old' }] }) }); });
      }
      const cookies = updated ? operation === 'set' ? [{ name: 'session', value: 'new' }] : [] : [{ name: 'session', value: 'original' }];
      return { ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies } : {} };
    });
    try {
      const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/' })} />);
      await prepareInspectorFrame(container);
      await user.click(screen.getByRole('button', { name: /Cookies/ }));
      await screen.findByText('original');
      blockNextRead = true;
      visibility.mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
      visibility.mockReturnValue('visible');
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => expect(finishOldRead).toBeTypeOf('function'));
      if (operation === 'set') {
        await user.click(screen.getByTitle('Edit'));
        const input = container.querySelector('.edit-input');
        await user.clear(input);
        await user.type(input, 'new');
        await user.click(screen.getByTitle('Save'));
      } else {
        await user.click(screen.getByTitle(operation === 'remove' ? 'Delete' : 'Clear all'));
      }
      const expectedCookies = operation === 'set' ? { session: 'new' } : {};
      await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual(expectedCookies));
      const expectedUpdate = { type: 'cookies', operation };
      if (operation !== 'clear') expectedUpdate.key = 'session';
      if (operation === 'set') expectedUpdate.value = 'new';
      expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/storage', expect.objectContaining({ method: 'POST', body: JSON.stringify(expectedUpdate) }));
      await act(async () => finishOldRead());
      expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual(expectedCookies);
    } finally {
      visibility.mockRestore();
      confirm.mockRestore();
    }
  });

  it('rejects a storage callback captured before iframe authorization after the document becomes ready', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    const mint = resourceAuthMock.getMockImplementation();
    let finishAuthorization;
    resourceAuthMock.mockImplementation((...args) => new Promise(resolve => {
      finishAuthorization = async () => resolve(await mint(...args));
    }));
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/' })} />);
    await waitFor(() => expect(finishAuthorization).toBeTypeOf('function'));
    const retiredUpdate = devToolsSpy.mock.lastCall[0].onUpdateStorage;
    await act(async () => finishAuthorization());
    await prepareInspectorFrame(container);
    await expect(retiredUpdate('cookies', 'clear')).rejects.toThrow('Preview changed before storage operation');
    expect(apiFetchMock.mock.calls.filter(([path, options]) => path.endsWith('/storage') && options?.method === 'POST')).toEqual([]);
  });

  it.each(['/preview/4173/another-page', '/preview/5173/app'])('ignores a cookie response from the previous URL after navigating to %s', async nextUrl => {
    let finishPreviousRead;
    let firstCookieRead = true;
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async input => {
      if (String(input).endsWith('/cookies') && firstCookieRead) {
        firstCookieRead = false;
        return new Promise(resolve => { finishPreviousRead = () => resolve({ ok: true, json: async () => ({ cookies: [{ name: 'session', value: 'previous-page' }] }) }); });
      }
      return { ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies: [{ name: 'session', value: 'current-page' }] } : {} };
    });
    const { rerender } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(finishPreviousRead).toBeTypeOf('function'));
    rerender(<PreviewPanel {...buildProps({ url: nextUrl })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-page' }));
    await act(async () => finishPreviousRead());
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-page' });
  });

  it('ignores an older mutation refresh that completes after a newer mutation refresh', async () => {
    let finishPreviousRefresh;
    let cookieReads = 0;
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async input => {
      if (String(input).endsWith('/cookies')) {
        cookieReads += 1;
        if (cookieReads === 2) return new Promise(resolve => { finishPreviousRefresh = () => resolve({ ok: true, json: async () => ({ cookies: [{ name: 'session', value: 'previous-edit' }] }) }); });
        return { ok: true, json: async () => ({ cookies: [{ name: 'session', value: cookieReads === 1 ? 'initial' : 'latest-edit' }] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'initial' }));
    let previousEdit;
    act(() => { previousEdit = devToolsSpy.mock.lastCall[0].onUpdateStorage('cookies', 'set', 'session', 'previous-edit'); });
    await waitFor(() => expect(finishPreviousRefresh).toBeTypeOf('function'));
    await act(async () => devToolsSpy.mock.lastCall[0].onUpdateStorage('cookies', 'set', 'session', 'latest-edit'));
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'latest-edit' });
    await act(async () => { finishPreviousRefresh(); await previousEdit; });
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'latest-edit' });
  });

  it('ignores a completed mutation after switching to a different preview', async () => {
    let finishMutation;
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') return new Promise(resolve => { finishMutation = () => resolve({ ok: true }); });
      return { ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies: [{ name: 'session', value: String(input).includes('/5173/') ? 'current-app' : 'previous-app' }] } : {} };
    });
    const { rerender, container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'previous-app' }));
    let mutation;
    act(() => { mutation = devToolsSpy.mock.lastCall[0].onUpdateStorage('cookies', 'set', 'session', 'updated'); });
    await waitFor(() => expect(finishMutation).toBeTypeOf('function'));
    rerender(<PreviewPanel {...buildProps({ url: '/preview/5173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' }));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toContain('/5173/'));
    const countReads = () => apiFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/cookies')).length;
    let readsBeforeCompletion = -1;
    while (readsBeforeCompletion !== countReads()) {
      readsBeforeCompletion = countReads();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    }
    await act(async () => { finishMutation(); await mutation; });
    expect(apiFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/cookies'))).toHaveLength(readsBeforeCompletion);
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' });
  });

  it.each(['prefixed', 'localhost'])('allows a paired %s app that happens to use the home UI port', async format => {
    const homeUiPort = window.location.port || '3020';
    setActiveEnvironment({ id: 'paired-host' });
    const url = format === 'prefixed' ? `/api/environments/paired-host/proxy/preview/${homeUiPort}/app` : `http://localhost:${homeUiPort}/app`;
    const { container } = render(<PreviewPanel {...buildProps({ url })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(new URL(container.querySelector('iframe').src).pathname).toBe(`/api/environments/paired-host/proxy/preview/${homeUiPort}/app`);
  });
  it.each(['preview', 'localhost'])('blocks a home %s preview of the current UI port', format => {
    const homeUiPort = window.location.port || '3020';
    const url = format === 'preview' ? `/preview/${homeUiPort}/app` : `http://localhost:${homeUiPort}/app`;
    const { container } = render(<PreviewPanel {...buildProps({ url })} />);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('does not apply an old importer callback to the current preview scope', async () => {
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async input => ({ ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies: [{ name: 'session', value: String(input).includes('/5173/') ? 'current-app' : 'previous-app' }] } : {} }));
    const { rerender } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'previous-app' }));
    const previousUpdate = devToolsSpy.mock.lastCall[0].onUpdateStorage;
    rerender(<PreviewPanel {...buildProps({ url: '/preview/5173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' }));
    await act(async () => expect(previousUpdate('cookies', 'set', 'imported', 'value')).rejects.toThrow('Preview changed before storage operation'));
    expect(apiFetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' });
  });

  it('retains current cookies when an imported file read finishes after navigation', async () => {
    let finishRead;
    const text = vi.fn(() => new Promise(resolve => { finishRead = resolve; }));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.localStorage.setItem('preview_devtools_visible_v1', 'true');
    apiFetchMock.mockImplementation(async input => ({ ok: true, json: async () => String(input).endsWith('/cookies') ? { cookies: [{ name: 'session', value: String(input).includes('/5173/') ? 'current-app' : 'previous-app' }] } : {} }));
    const { rerender } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'previous-app' }));
    fireEvent.click(screen.getByRole('button', { name: /Cookies/ }));
    fireEvent.change(screen.getByTitle('Import storage').querySelector('input'), { target: { files: [{ size: 100, text }] } });
    expect(text).toHaveBeenCalledOnce();
    rerender(<PreviewPanel {...buildProps({ url: '/preview/5173/app' })} />);
    await waitFor(() => expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' }));
    await act(async () => finishRead(JSON.stringify({ data: { imported: 'value' } })));
    expect(devToolsSpy.mock.lastCall[0].storage.cookies).toEqual({ session: 'current-app' });
    expect(apiFetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    consoleError.mockRestore();
    alert.mockRestore();
  });
  it.each([false, true])('opens and closes the selected element style editor on mobile=%s', async mobile => {
    isMobile = mobile;
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    expect(screen.queryByRole('button', { name: 'Edit styles' })).not.toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const { iframe, epoch } = await prepareInspectorFrame(container);
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');
    if (!mobile) act(() => previewUrlBarSpy.mock.lastCall[0].onToggleInspect());
    fireEvent(window, new MessageEvent('message', { source: iframe.contentWindow, data: {
      type: 'preview-element-selected', previewEpoch: epoch, element: {
        elementId: 'selected-button', selector: '#preview-button', tagName: 'BUTTON',
        rect: { x: 0, y: 0, width: 100, height: 40 }, attributes: { id: 'preview-button' },
        computedStyle: { display: 'block', position: 'static' },
      },
    } }));
    const editStyles = screen.getByRole('button', { name: 'Edit styles' });
    expect(editStyles).toHaveAttribute('aria-expanded', 'false');
    await user.click(editStyles);
    expect(screen.getByText('Style Editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide style editor' })).toHaveAttribute('aria-expanded', 'true');
    await user.selectOptions(screen.getByLabelText('Display'), 'flex');
    expect(postMessage).toHaveBeenCalledWith({ type: 'preview-apply-style-preview', elementId: 'selected-button', styles: { display: 'flex' } }, '*');
    await user.click(screen.getByRole('button', { name: 'Hide style editor' }));
    expect(screen.queryByText('Style Editor')).not.toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith({ type: 'preview-revert-style-preview' }, '*');
    if (!mobile) {
      await user.click(screen.getByRole('button', { name: 'Edit styles' }));
      await user.selectOptions(screen.getByLabelText('Display'), 'grid');
      postMessage.mockClear();
      act(() => previewUrlBarSpy.mock.lastCall[0].onToggleInspect());
      expect(screen.queryByText('Style Editor')).not.toBeInTheDocument();
      expect(postMessage).toHaveBeenCalledWith({ type: 'preview-revert-style-preview' }, '*');
    }
  });

  it.each([
    ['/tmp/preview space # %.html', '/tmp', 'preview space # %.html'],
    [String.raw`C:\project space\index.html`, String.raw`C:\project space`, 'index.html'],
    ['file:///tmp/preview%20space/index.html', '/tmp/preview space', 'index.html'],
    ['/api/preview?path=%2Ftmp&file=index.html', '/tmp', 'index.html'],
  ])('routes static file target %s through authenticated preview', async (url, directory, filename) => {
    const { container } = render(<PreviewPanel {...buildProps({ url })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const target = new URL(iframe.src);
    expect(target.pathname).toBe(new URL(resolveApiUrl('/api/preview'), window.location.origin).pathname);
    expect(target.searchParams.get('path')).toBe(directory);
    expect(target.searchParams.get('file')).toBe(filename);
    expect(target.searchParams.get('token')).toBeNull();
  });

  it('routes raw static files through the selected paired host', async () => {
    setActiveEnvironment({ id: 'paired-host' });
    const { container } = render(<PreviewPanel {...buildProps({ url: '/tmp/paired file.html' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const target = new URL(container.querySelector('iframe').src);
    expect(target.pathname).toBe(new URL(resolveApiUrl('/api/preview'), window.location.origin).pathname);
    expect(target.searchParams.get('path')).toBe('/tmp');
    expect(target.searchParams.get('file')).toBe('paired file.html');
    expect(target.searchParams.get('token')).toBeNull();
  });

  it.each([
    [false, 'https://api.example.com'],
    [true, 'https://api.example.com'],
    [false, 'https://api.example.com/terminal'],
    [true, 'https://api.example.com/terminal'],
  ])('preserves configured static API routing for paired=%s base=%s', async (paired, apiBase) => {
    configuredApiBase = apiBase;
    if (paired) setActiveEnvironment({ id: 'paired-host' });
    const { container } = render(<PreviewPanel {...buildProps({ url: '/tmp/static file.html' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const target = new URL(container.querySelector('iframe').src);
    expect(target.origin).toBe('https://api.example.com');
    const basePath = new URL(apiBase).pathname.replace(/\/$/, '');
    expect(target.pathname).toBe(basePath + (paired ? '/api/environments/paired-host/proxy/api/preview' : '/api/preview'));
    expect(target.searchParams.get('path')).toBe('/tmp');
    expect(target.searchParams.get('file')).toBe('static file.html');
    expect(target.searchParams.get('token')).toBeNull();
  });

  it('opens raw static files in a new tab through a fresh resource grant', async () => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    render(<PreviewPanel {...buildProps({ url: '/tmp/static file.html' })} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onOpenExternal());
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const target = new URL(popup.location.replace.mock.lastCall[0], window.location.origin);
    expect(target.pathname).toBe(new URL(resolveApiUrl('/api/preview'), window.location.origin).pathname);
    expect(target.searchParams.get('path')).toBe('/tmp');
    expect(target.searchParams.get('file')).toBe('static file.html');
    expect(target.searchParams.get('token')).toBeNull();
    open.mockRestore();
  });

  it.each([
    '/preview/4173/app?token=old-access-token',
    '/api/preview?path=%2Ftmp&file=index.html&token=old-access-token',
    '/api/environments/paired-host/proxy/preview/4173/app?token=old-access-token',
    '/api/environments/paired-host/proxy/api/preview?path=%2Ftmp&file=index.html&token=old-access-token',
  ])('removes persisted access tokens from iframe URL %s', async url => {
    const { container } = render(<PreviewPanel {...buildProps({ url })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    expect(new URL(container.querySelector('iframe').src).searchParams.has('token')).toBe(false);
  });

  it('authorizes external proxy documents without full access credentials in their URL', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: 'https://external.example.com/app' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const target = new URL(container.querySelector('iframe').src);
    expect(target.pathname).toBe('/api/proxy-external');
    expect(target.searchParams.has('token')).toBe(false);
    expect(target.searchParams.get('previewToken')).toBe('read-only-resource-ticket');
  });

  it.each([
    '/preview/4173/app?token=old-access-token',
    '/api/preview?path=%2Ftmp&file=index.html&token=old-access-token',
    '/api/environments/paired-host/proxy/preview/4173/app?token=old-access-token',
  ])('authorizes persisted new-tab target without broad access credentials: %s', async url => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    render(<PreviewPanel {...buildProps({ url })} />);
    act(() => previewUrlBarSpy.mock.lastCall[0].onOpenExternal());
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const target = new URL(popup.location.replace.mock.lastCall[0]);
    expect(target.searchParams.has('token')).toBe(false);
    expect(target.searchParams.get('previewToken')).toBe('read-only-resource-ticket');
    open.mockRestore();
  });

  it('keeps failed minting out of the iframe and allows an explicit retry', async () => {
    resourceAuthMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Preview is not permitted' }) });
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview is not permitted');
    expect(container.querySelector('iframe').getAttribute('src')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('read-only-resource-ticket'));
  });

  it('brokers current authorized iframe metrics without accepting an old document grant', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBeTruthy());
    const iframe = container.querySelector('iframe');
    const metrics = [{ type: 'runtimeMetrics', timestamp: 123, data: { fps: 60 } }];
    fireEvent(window, new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-performance', port: 4173, documentUrl: iframe.src, documentGrant: new URL(iframe.src).searchParams.get('previewToken'), metrics } }));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/preview/4173/performance', expect.objectContaining({ home: true, method: 'POST', body: { metrics } }));
    const calls = apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/performance')).length;
    fireEvent(window, new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-performance', port: 4173, documentUrl: iframe.src.replace('read-only-resource-ticket', 'old-grant'), documentGrant: 'old-grant', metrics } }));
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/performance'))).toHaveLength(calls);
  });

  it('keeps ordinary application routes out of the iframe', () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/settings' })} />);
    expect(container.querySelector('iframe')).toBeNull();
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

  it('shows busy state for inactive preview sessions', async () => {
    render(
      <PreviewPanel
        {...buildProps({
          activeSessions: [
            { id: 'session-1', title: 'Terminal 1', usesTmux: false },
            { id: 'session-2', title: 'Terminal 2', usesTmux: false },
          ],
          activeSessionId: 'session-1',
          sessionActivity: {
            'session-2': { isBusy: true },
          },
          showStatusLabels: true,
        })}
      />,
    );

    const inactiveBusyButton = await screen.findByTitle('Terminal 2');
    expect(inactiveBusyButton.className).toContain('busy');
    expect(inactiveBusyButton.querySelector('.session-status-label.busy')?.textContent).toBe('Busy');
  });

  it('disambiguates duplicate preview session labels', async () => {
    render(
      <PreviewPanel
        {...buildProps({
          activeSessions: [
            { id: 'session-1', title: 'terminal v4', usesTmux: false },
            { id: 'session-2', title: 'terminal v4', usesTmux: false },
          ],
          activeSessionId: 'session-1',
        })}
      />,
    );

    expect(await screen.findByRole('button', { name: 'terminal v4 (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'terminal v4 (2)' })).toBeInTheDocument();
  });

  it('includes uploaded attachments when submitting from the preview composer', async () => {
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel {...buildProps()} />);

    const fileInput = container.querySelector('.status-composer-image-input');
    expect(fileInput).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add image' }));

    await user.upload(
      fileInput,
      new File(['preview-image'], 'preview-image.png', { type: 'image/png' }),
    );

    await waitFor(() => {
      expect(uploadScreenshotMock).toHaveBeenCalled();
    });

    await user.type(screen.getByRole('textbox', { name: 'Command composer' }), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/terminal/session-1/input',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: '"C:/tmp/preview image.png" hello\r' }),
        }),
      );
    });
  });

  it('submits preview composer commands with Enter so the shell runs them', async () => {
    const user = userEvent.setup();
    const command = 'echo preview-composer';
    const expectedBody = JSON.stringify({ command: `${command}\r` });
    render(<PreviewPanel {...buildProps()} />);

    await user.type(screen.getByRole('textbox', { name: 'Command composer' }), command);
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/terminal/session-1/input',
        expect.objectContaining({ method: 'POST', body: expectedBody }),
      );
    });
  });

  it('passes the active app scope to the preview header', async () => {
    render(
      <PreviewPanel
        {...buildProps({
          projectInfo: {
            cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
            projectType: 'node',
            projectName: 'terminal v4',
            startCommand: 'npm run dev',
          },
          activeSessions: [{
            id: 'session-1',
            title: 'Terminal 1',
            cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
            usesTmux: false,
          }],
        })}
      />,
    );

    await waitFor(() => {
      const props = previewUrlBarSpy.mock.lastCall?.[0];
      expect(props).toBeTruthy();
      expect(props.activePreviewScope).toEqual(expect.objectContaining({
        appLabel: 'terminal v4',
        sessionLabel: 'Terminal 1',
        cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
      }));
    });
  });

  it('shows the project in the empty preview state without marking it active', async () => {
    render(
      <PreviewPanel
        {...buildProps({
          projectInfo: {
            cwd: 'C:\\Users\\conor',
            projectType: 'static',
            indexPath: 'C:\\Users\\conor\\index.html',
          },
          activeSessions: [{
            id: 'session-1',
            title: 'Terminal 1',
            cwd: 'C:\\Users\\conor',
            usesTmux: false,
          }],
        })}
      />,
    );

    expect(await screen.findByText(/Project:/)).toBeInTheDocument();
    expect(screen.getByText('conor', { selector: '.preview-empty-scope strong' })).toBeInTheDocument();
    expect(screen.getByText('Following session: Terminal 1')).toBeInTheDocument();
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

  it('restores persisted mobile terminal mode instead of resetting to preview', async () => {
    isMobile = true;
    window.localStorage.setItem(MOBILE_VIEW_MODE_KEY, 'terminal');

    render(<PreviewPanel {...buildProps()} />);

    expect(await screen.findByTestId('terminal-chat-session-1')).toBeInTheDocument();
    expect(window.localStorage.getItem(MOBILE_VIEW_MODE_KEY)).toBe('terminal');
  });

  it('migrates the legacy mobile split flag to a rendered terminal mode', async () => {
    isMobile = true;
    window.localStorage.setItem(MOBILE_SPLIT_ENABLED_KEY, 'true');

    render(<PreviewPanel {...buildProps()} />);

    await waitFor(() => {
      expect(window.localStorage.getItem(MOBILE_VIEW_MODE_KEY)).toBe('terminal');
    });
    expect(await screen.findByTestId('terminal-chat-session-1')).toBeInTheDocument();
  });

  it('normalizes persisted split mode to the supported terminal view', async () => {
    isMobile = true;
    localStorage.setItem(MOBILE_VIEW_MODE_KEY, 'split');
    render(<PreviewPanel {...buildProps()} />);
    expect(await screen.findByTestId('terminal-chat-session-1')).toBeInTheDocument();
    expect(localStorage.getItem(MOBILE_VIEW_MODE_KEY)).toBe('terminal');
  });

  it('subscribes to network logs only while desktop Debug is visible and cleans up reconnects', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class {
      constructor(url) { this.url = url; this.listeners = {}; this.close = vi.fn(); streams.push(this); }
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    const { container, unmount } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(previewUrlBarSpy).toHaveBeenCalled());
    expect(streams).toHaveLength(0);
    act(() => previewUrlBarSpy.mock.lastCall[0].onSetDesktopLayout('debug'));
    await waitFor(() => expect(streams).toHaveLength(1));
    const request = { id: 'fixture', timestamp: 123, method: 'GET', url: '/fixture', status: 200 };
    act(() => streams[0].listeners.proxy({ data: JSON.stringify(request) }));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([request]);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: container.querySelector('iframe').contentWindow,
      data: { type: 'preview-error', message: 'synthetic error', timestamp: 124 } })));
    act(() => previewUrlBarSpy.mock.lastCall[0].onSetDesktopLayout('preview'));
    expect(streams[0].close).toHaveBeenCalledOnce();
    act(() => previewUrlBarSpy.mock.lastCall[0].onSetDesktopLayout('debug'));
    expect(streams).toHaveLength(2);
    act(() => streams[1].onerror());
    unmount();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(streams).toHaveLength(2);
  });

  it('stops Debug network collection while the document is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const streams = [];
    vi.stubGlobal('EventSource', class {
      constructor() { this.close = vi.fn(); streams.push(this); }
      addEventListener() {}
    });
    localStorage.setItem('preview_devtools_visible_v1', 'true');
    const { unmount } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(streams).toHaveLength(1));
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(streams[0].close).toHaveBeenCalledOnce();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(streams).toHaveLength(2);
    unmount();
    expect(streams[1].close).toHaveBeenCalledOnce();
    visibility.mockRestore();
  });

  it.each([404, 500])('retains preview composer text and attachment on HTTP %s and retries deliberately', async status => {
    const props = buildProps();
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Add image' }));
    await user.upload(container.querySelector('.status-composer-image-input'), new File(['fixture'], 'fixture.png', { type: 'image/png' }));
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    await user.type(composer, 'reviewed fixture');
    apiFetchMock.mockImplementation(async () => ({ ok: false, status, json: async () => ({}) }));
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send');
    expect(composer).toHaveValue('reviewed fixture');
    expect(screen.getByRole('button', { name: /Remove.*fixture.png/ })).toBeInTheDocument();
    expect(props.onSendToTerminal).not.toHaveBeenCalled();
    apiFetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
    await user.click(screen.getByRole('button', { name: 'Send to terminal' }));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(screen.queryByRole('button', { name: /Remove.*fixture.png/ })).not.toBeInTheDocument();
  });

  it.each([false, true])('requires a reviewed parent Send for iframe intent on mobile=%s', async mobile => {
    isMobile = mobile;
    const props = buildProps({ url: '/preview/4173/app' });
    const { container } = render(<PreviewPanel {...props} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    const { iframe, epoch } = await prepareInspectorFrame(container);
    const frame = iframe.contentWindow;
    const data = { type: 'preview-send-to-terminal', previewEpoch: epoch, userClicked: true, element: { selector: '#fixture\nMARKER\r\u001b', tagName: 'button' } };
    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data })));
    expect(screen.queryByRole('dialog', { name: 'Review preview context' })).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame, data })));
    const review = await screen.findByRole('dialog', { name: 'Review preview context' });
    expect(review).toHaveTextContent('Preview content is untrusted');
    const context = screen.getByRole('textbox', { name: 'Preview context to send' }).value;
    expect(context).toContain('MARKER');
    expect(context).not.toMatch(/[\r\n\u001b]/);
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input'))).toEqual([]);
    expect(props.onSendToTerminal).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { ...data, element: { selector: '#replacement' } } })));
    expect(screen.getByRole('textbox', { name: 'Preview context to send' })).toHaveValue(context);
    fireEvent.click(screen.getByRole('button', { name: 'Send reviewed context' }));
    if (mobile) {
      await waitFor(() => expect(props.onSendToTerminal).toHaveBeenCalledWith(context));
    } else {
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/terminal/session-1/input', expect.objectContaining({ body: JSON.stringify({ command: context }) })));
    }
  });

  it('rejects malformed context and old frame messages after navigation and clears pending review', async () => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    const { iframe, epoch } = await prepareInspectorFrame(container);
    const oldFrame = iframe.contentWindow;
    const send = element => window.dispatchEvent(new MessageEvent('message', { source: oldFrame, data: { type: 'preview-send-to-terminal', previewEpoch: epoch, element } }));
    act(() => send({ selector: { bad: 'object' } }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => send({ selector: 'x'.repeat(100000) }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => send({ selector: '#fixture' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    rerender(<PreviewPanel {...props} url="/preview/5173/next" />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('/preview/5173/next'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => send({ selector: '#stale' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input'))).toEqual([]);
  });

  it('renders serialized ancestor breadcrumbs without dispatching DOM clicks and retains style selection', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    const { iframe, epoch } = await prepareInspectorFrame(container);
    const frame = iframe.contentWindow;
    const post = vi.spyOn(frame, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { type: 'preview-element-selected', previewEpoch: epoch, element: {
      selector: '#fixture', tagName: 'button', elementId: 'fixture-element',
      parentChain: [{ tagName: 'main', selector: 'main#app' }, { tagName: 'body', selector: 'body' }],
      rect: { x: 0, y: 0, width: 20, height: 10 }, attributes: {}, computedStyle: { display: 'block' },
      outerHTML: '<button>' + ' \n'.repeat(2490),
    } } })));
    expect(container.querySelector('.inspector-breadcrumb').textContent).toBe('body›main#app›#fixture');
    fireEvent.click(screen.getByRole('button', { name: 'Edit styles' }));
    fireEvent.change(screen.getByLabelText('Display'), { target: { value: 'flex' } });
    expect(post).toHaveBeenCalledWith({ type: 'preview-apply-style-preview', elementId: 'fixture-element', styles: { display: 'flex' } }, '*');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Terminal' }));
    expect(await screen.findByRole('dialog', { name: 'Review preview context' })).toBeInTheDocument();
  });

  it('invalidates pending review and selected element when the iframe document loads again', async () => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('previewToken'));
    const { iframe, epoch } = await prepareInspectorFrame(container);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-send-to-terminal', previewEpoch: epoch, element: { selector: '#fixture' } } })));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.load(iframe);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'preview-send-to-terminal', previewEpoch: epoch, element: { selector: '#stale' } } })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.filter(([path]) => path.endsWith('/input'))).toEqual([]);
  });

  it('renews the inspector epoch when iframe navigation updates the parent URL without a reload', async () => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe, epoch } = await prepareInspectorFrame(container);
    const frame = iframe.contentWindow;
    const post = vi.mocked(frame.postMessage);
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame, data: { type: 'preview-location', url: 'http://localhost:4173/next?theme=blue' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalledWith('http://localhost:4173/next?theme=blue'));
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    expect(container.querySelector('iframe')).toBe(iframe);
    const nextEpoch = post.mock.calls.findLast(([message]) => message.type === 'preview-parent-ready')?.[0].previewEpoch;
    expect(nextEpoch).toEqual(expect.any(String));
    expect(nextEpoch).not.toBe(epoch);
    const select = previewEpoch => window.dispatchEvent(new MessageEvent('message', {
      source: frame, data: { type: 'preview-element-selected', previewEpoch, element: {
        selector: '#current', tagName: 'button', elementId: 'current-element', attributes: {},
        computedStyle: {}, rect: { x: 0, y: 0, width: 200, height: 80 }
      } }
    }));
    act(() => select(epoch));
    expect(container.querySelector('.preview-inspector')).not.toBeInTheDocument();
    act(() => select(nextEpoch));
    expect(container.querySelector('.preview-inspector')).toBeInTheDocument();
  });

  it('keeps the internal preview grant out of navigation while retaining application query values', async () => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: {
        type: 'preview-location', url: 'http://localhost:4173/next?previewToken=internal-grant&theme=blue&token=application-value#details'
      }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalledWith('http://localhost:4173/next?theme=blue&token=application-value#details'));
  });
  it('reloads the visible current path and application query after SPA navigation', async () => {
    const props = buildProps({ url: '/preview/4173/original?token=initial#start' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow,
      data: { type: 'preview-location', url: 'http://localhost:4173/current?token=business-current#next' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalled());
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    expect(container.querySelector('iframe')).toBe(iframe);
    act(() => previewUrlBarSpy.mock.lastCall[0].onRefresh());
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('/preview/4173/current?'));
    const reloaded = new URL(container.querySelector('iframe').src);
    expect([reloaded.searchParams.get('token'), reloaded.hash]).toEqual(['business-current', '#next']);
  });

  it.each(['onClearCache', 'onClearCookies'])('%s reload retains the visible SPA URL and query cache-buster', async action => {
    const props = buildProps({ url: '/preview/4173/original?token=initial#start' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    act(() => window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow,
      data: { type: 'preview-location', url: 'http://localhost:4173/current?token=business-current#next' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalled());
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    expect(container.querySelector('iframe')).toBe(iframe);
    await act(async () => previewUrlBarSpy.mock.lastCall[0][action]());
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('/preview/4173/current?'));
    const reloaded = new URL(container.querySelector('iframe').src);
    expect([reloaded.searchParams.get('token'), reloaded.hash, reloaded.searchParams.has('_cb')]).toEqual(['business-current', '#next', true]);
  });

  it.each(['onClearCache', 'onClearCookies'])('%s reports a rejected clear without reloading the preview', async action => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    const original = iframe.src;
    apiFetchMock.mockImplementation(async (_path, options) => ({ ok: options?.method !== 'DELETE', json: async () => ({}) }));
    await act(async () => previewUrlBarSpy.mock.lastCall[0][action]());
    expect(screen.getByRole('alert')).toHaveTextContent(/could not clear/i);
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(iframe.src).toBe(original);
  });

  it.each(['onClearCache', 'onClearCookies'])('%s does not reload a newer SPA route when an earlier clear finishes', async action => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    const original = iframe.src;
    let finish;
    apiFetchMock.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/cookies') && options?.method === 'DELETE') {
        return new Promise(resolve => { finish = () => resolve({ ok: true }); });
      }
      return { ok: true, json: async () => ({}) };
    });
    let clearing;
    act(() => { clearing = previewUrlBarSpy.mock.lastCall[0][action](); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'preview-location', url: 'http://localhost:4173/newer#next' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalled());
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    await act(async () => { finish(); await clearing; });
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(iframe.src).toBe(original);
  });
  it.each(['onClearCache', 'onClearCookies'])('%s ignores failure after logical SPA navigation', async action => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    let finish;
    apiFetchMock.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/cookies') && options?.method === 'DELETE') {
        return new Promise(resolve => { finish = () => resolve({ ok: false }); });
      }
      return { ok: true, json: async () => ({}) };
    });
    let clearing;
    act(() => { clearing = previewUrlBarSpy.mock.lastCall[0][action](); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'preview-location', url: 'http://localhost:4173/newer#next' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalled());
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    await act(async () => { finish(); await clearing; });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['onClearCache', 'onClearCookies'])('%s dismisses an old failure when logical navigation changes', async action => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    apiFetchMock.mockImplementation(async (_path, options) => ({ ok: options?.method !== 'DELETE', json: async () => ({}) }));
    await act(async () => previewUrlBarSpy.mock.lastCall[0][action]());
    expect(screen.getByRole('alert')).toHaveTextContent(/could not clear/i);
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { type: 'preview-location', url: 'http://localhost:4173/newer#next' }
    })));
    await waitFor(() => expect(props.onUrlChange).toHaveBeenCalled());
    rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['onClearCache', 'onClearCookies'].flatMap(action => ['success', 'nonok', 'reject'].map(outcome => [action, outcome])))('%s ignores %s from an earlier visit after A-B-A navigation', async (action, outcome) => {
    const props = buildProps({ url: '/preview/4173/app' });
    const { container, rerender } = render(<PreviewPanel {...props} />);
    const { iframe } = await prepareInspectorFrame(container);
    const original = iframe.src;
    let finish;
    apiFetchMock.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/cookies') && options?.method === 'DELETE') {
        return new Promise((resolve, reject) => { finish = () => outcome === 'reject' ? reject(new Error('Synthetic rejected clear')) : resolve({ ok: outcome === 'success' }); });
      }
      return { ok: true, json: async () => ({}) };
    });
    let clearing;
    act(() => { clearing = previewUrlBarSpy.mock.lastCall[0][action](); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    for (const path of ['/newer#next', '/app']) {
      act(() => window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow, data: { type: 'preview-location', url: 'http://localhost:4173' + path }
      })));
      await waitFor(() => expect(props.onUrlChange.mock.lastCall?.[0]).toBe('http://localhost:4173' + path));
      rerender(<PreviewPanel {...props} url={props.onUrlChange.mock.lastCall[0]} />);
    }
    await act(async () => { finish(); await clearing; });
    expect([screen.queryByRole('alert'), iframe.src]).toEqual([null, original]);
  });

  it.each(['onClearCache', 'onClearCookies'].flatMap(action => ['success', 'nonok', 'reject'].map(outcome => [action, outcome])))('%s ignores %s after same-URL document replacement', async (action, outcome) => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    const original = iframe.src;
    let finish;
    apiFetchMock.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/cookies') && options?.method === 'DELETE') {
        return new Promise((resolve, reject) => { finish = () => outcome === 'reject' ? reject(new Error('Synthetic rejected clear')) : resolve({ ok: outcome === 'success' }); });
      }
      return { ok: true, json: async () => ({}) };
    });
    let clearing;
    act(() => { clearing = previewUrlBarSpy.mock.lastCall[0][action](); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.load(iframe);
    await act(async () => { finish(); await clearing; });
    expect([screen.queryByRole('alert'), iframe.src]).toEqual([null, original]);
  });

  it.each(['onClearCache', 'onClearCookies'])('%s removes a previous error after same-URL document replacement', async action => {
    const { container } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    const { iframe } = await prepareInspectorFrame(container);
    apiFetchMock.mockImplementation(async (_path, options) => ({ ok: options?.method !== 'DELETE', json: async () => ({}) }));
    await act(async () => previewUrlBarSpy.mock.lastCall[0][action]());
    expect(screen.getByRole('alert')).toHaveTextContent(/could not clear/i);
    fireEvent.load(iframe);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resumes proxy append cursor across transient disconnect and fences old source events', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class {
      constructor(url) { this.url = url; this.listeners = {}; this.close = vi.fn(); streams.push(this); }
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    localStorage.setItem('preview_devtools_visible_v1', 'true');
    const { unmount } = render(<PreviewPanel {...buildProps({ url: '/preview/4173/app' })} />);
    await waitFor(() => expect(streams).toHaveLength(1));
    const fast = { id: '0000000000000001-00000000-0000-4000-8000-000000000001', timestamp: 20, method: 'GET', url: '/fast' };
    act(() => streams[0].listeners.proxy({ data: JSON.stringify(fast), lastEventId: fast.id }));
    act(() => streams[0].onerror());
    await waitFor(() => expect(streams).toHaveLength(2), { timeout: 2500 });
    expect(new URL(streams[1].url, location.origin).searchParams.get('proxyAfter')).toBe(fast.id);
    const late = { id: '0000000000000002-00000000-0000-4000-8000-000000000002', timestamp: 10, method: 'GET', url: '/late' };
    act(() => streams[1].listeners.proxy({ data: JSON.stringify(late), lastEventId: late.id }));
    act(() => streams[0].listeners.proxy({ data: JSON.stringify(fast), lastEventId: fast.id }));
    act(() => streams[1].listeners.proxy({ data: JSON.stringify(late), lastEventId: late.id }));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([fast, late]);
    act(() => streams[1].onerror());
    await waitFor(() => expect(streams).toHaveLength(3), { timeout: 2500 });
    expect(new URL(streams[2].url, location.origin).searchParams.get('proxyAfter')).toBe(late.id);
    unmount();
  });

  it('clears opaque cursor and fences pending events across clear navigation and identity changes', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class {
      constructor(url) { this.url = url; this.listeners = {}; this.close = vi.fn(); streams.push(this); }
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    localStorage.setItem('preview_devtools_visible_v1', 'true');
    const props = buildProps({ url: '/preview/4173/app' });
    const { rerender, unmount } = render(<PreviewPanel {...props} />);
    await waitFor(() => expect(streams).toHaveLength(1));
    const log = { id: '0000000000000001-00000000-0000-4000-8000-000000000001', timestamp: 20, method: 'GET', url: '/fast' };
    const emit = source => source.listeners.proxy({ data: JSON.stringify(log), lastEventId: log.id });
    act(() => emit(streams[0]));
    let finishDelete;
    apiFetchMock.mockImplementation(async (_path, options) => options?.method === 'DELETE' ? new Promise(resolve => { finishDelete = resolve; }) : { ok: true, json: async () => ({}) });
    let clear;
    act(() => { clear = devToolsSpy.mock.lastCall[0].onClearNetwork(); });
    act(() => emit(streams[0]));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([]);
    await act(async () => { finishDelete({ ok: true }); await clear; });
    await waitFor(() => expect(streams.length).toBeGreaterThan(1));
    const afterClear = streams.at(-1);
    expect(new URL(afterClear.url, location.origin).searchParams.has('proxyAfter')).toBe(false);
    act(() => emit(afterClear));
    const beforeNavigation = streams.length;
    rerender(<PreviewPanel {...props} url='/preview/4173/next' />);
    await waitFor(() => expect(streams.length).toBeGreaterThan(beforeNavigation));
    act(() => emit(afterClear));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([]);
    expect(new URL(streams.at(-1).url, location.origin).searchParams.has('proxyAfter')).toBe(false);
    const beforeIdentity = streams.length;
    const previousIdentitySource = streams.at(-1);
    const { setTokens } = await import('../utils/auth');
    act(() => { setTokens('synthetic-new-owner', 'synthetic-refresh'); emit(previousIdentitySource); });
    await waitFor(() => expect(streams.length).toBeGreaterThan(beforeIdentity));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([]);
    expect(new URL(streams.at(-1).url, location.origin).searchParams.has('proxyAfter')).toBe(false);
    unmount();
  });

  it('fences old proxy events and drops resume cursor on same-URL document replacement', async () => {
    const streams=[];
    vi.stubGlobal('EventSource',class {constructor(url){this.url=url;this.listeners={};this.close=vi.fn();streams.push(this)}addEventListener(type,callback){this.listeners[type]=callback}});
    localStorage.setItem('preview_devtools_visible_v1','true');
    const {container,unmount}=render(<PreviewPanel {...buildProps({url:'/preview/4173/app'})}/>);
    await waitFor(()=>expect(streams).toHaveLength(1));
    const log={id:'0000000000000001-00000000-0000-4000-8000-000000000001',timestamp:20,url:'/fast'};
    act(()=>streams[0].listeners.proxy({data:JSON.stringify(log),lastEventId:log.id}));
    fireEvent.load(container.querySelector('iframe'));
    await waitFor(()=>expect(streams).toHaveLength(2));
    act(()=>streams[0].listeners.proxy({data:JSON.stringify(log),lastEventId:log.id}));
    expect(devToolsSpy.mock.lastCall[0].networkRequests).toEqual([]);
    expect(new URL(streams[1].url,location.origin).searchParams.has('proxyAfter')).toBe(false);
    unmount();
  });

});
