import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RemoteDesktopPanel from './RemoteDesktopPanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const reply = data => ({ ok: true, json: async () => data });
const display = { available: true, control: true, monitors: [{ id: 'fixture-display', label: 'Synthetic display', width: 400, height: 300 }] };
const session = { id: 'synthetic-desktop-session', expiresAt: 2000000000 };
const requests = [];
beforeEach(() => {
  requests.length = 0;
  apiFetch.mockReset(); setActiveEnvironment(null);
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-desktop'); URL.revokeObjectURL = vi.fn();
  apiFetch.mockImplementation(async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/status')) return reply(display);
    if (url.endsWith('/sessions') && options.method === 'POST') return reply(session);
    if (url.endsWith('/frame')) return { ok: true, blob: async () => new Blob(['synthetic frame']) };
    return { ok: true, status: 204 };
  });
});
afterEach(() => { cleanup(); setActiveEnvironment(null); vi.useRealTimers(); });
async function view() {
  fireEvent.click(await screen.findByRole('button', { name: 'Start viewing' }));
  await screen.findByAltText('Live remote Windows desktop');
  fireEvent.click(screen.getByLabelText('Enable remote keyboard and pointer control'));
  return screen.getByAltText('Live remote Windows desktop');
}

it('delivers keyboard input in order when an earlier input request is delayed', async () => {
  const base = apiFetch.getMockImplementation();
  let finish;
  const input = [];
  apiFetch.mockImplementation((url, options) => {
    if (url.endsWith('/input')) {
      input.push(options.body);
      if (input.length === 1) return new Promise(resolve => { finish = resolve; });
    }
    return base(url, options);
  });
  render(<RemoteDesktopPanel />);
  const image = await view();
  fireEvent.keyDown(image, { key: 'a', code: 'KeyA' });
  fireEvent.keyDown(image, { key: 'b', code: 'KeyB' });
  fireEvent.keyDown(image, { key: 'c', code: 'KeyC' });
  expect(input).toHaveLength(1);
  await act(async () => finish({ ok: true, status: 204 }));
  await waitFor(() => expect(input).toEqual(['KeyA', 'KeyB', 'KeyC'].map(key => ({ kind: 'key', key, modifiers: [] }))));
});

it('consumes Escape to disable control while keeping its viewing session mounted', async () => {
  const outerKey = vi.fn();
  render(<div onKeyDown={outerKey}><RemoteDesktopPanel /></div>);
  const image = await view();
  fireEvent.keyDown(image, { key: 'Escape' });
  expect(outerKey).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Enable remote keyboard and pointer control')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Stop viewing' })).toBeVisible();
  expect(requests.some(([, options]) => options.method === 'DELETE')).toBe(false);
});

it('retains an unconfirmed Stop for retry and unmount cleanup', async () => {
  const base = apiFetch.getMockImplementation();
  let deleteAttempts = 0;
  apiFetch.mockImplementation((url, options) => {
    if (options.method === 'DELETE' && ++deleteAttempts === 1) return Promise.reject(new Error('Synthetic stop unavailable'));
    return base(url, options);
  });
  const fixture = render(<RemoteDesktopPanel />);
  await view();
  fireEvent.click(screen.getByRole('button', { name: 'Stop viewing' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic stop unavailable');
  expect(screen.queryByRole('button', { name: 'Start viewing' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry stopping' }));
  expect(await screen.findByRole('button', { name: 'Start viewing' })).toBeEnabled();
  expect(deleteAttempts).toBe(2);
  fixture.unmount();
  expect(deleteAttempts).toBe(2);
});

it('retries transient frame contention without ending the viewing session', async () => {
  const base = apiFetch.getMockImplementation();
  let frames = 0;
  apiFetch.mockImplementation((url, options) => {
    if (url.endsWith('/frame') && ++frames === 1) return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'Desktop helper busy' }) });
    return base(url, options);
  });
  vi.useFakeTimers();
  await act(async () => { render(<RemoteDesktopPanel />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start viewing' })));
  await act(async () => vi.advanceTimersByTime(150));
  expect(screen.getByAltText('Live remote Windows desktop')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('retries an initial status failure without leaving remote tools', async () => {
  apiFetch.mockRejectedValueOnce(new Error('Synthetic status unavailable'));
  render(<RemoteDesktopPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic status unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry desktop status' }));
  expect(await screen.findByRole('button', { name: 'Start viewing' })).toBeEnabled();
});

it('refreshes a successful unavailable capability response and recovers without starting a desktop session', async () => {
  apiFetch.mockResolvedValueOnce(reply({ enabled: true, available: false, control: false, monitors: [], message: 'Synthetic helper temporarily unavailable' }))
    .mockResolvedValueOnce(reply(display));
  render(<RemoteDesktopPanel />);
  expect(await screen.findByText('Synthetic helper temporarily unavailable')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh desktop status' }));
  expect(await screen.findByRole('button', { name: 'Start viewing' })).toBeEnabled();
  expect(screen.queryByText('Synthetic helper temporarily unavailable')).not.toBeInTheDocument();
  expect(apiFetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual(Array(2).fill(['/api/desktop/status', undefined]));
});

it('ignores an unavailable-status refresh after switching to a host without desktop permission', async () => {
  let finishRefresh;
  let refreshSignal;
  apiFetch.mockResolvedValueOnce(reply({ available: false, monitors: [], message: 'Synthetic helper unavailable' }))
    .mockImplementationOnce((_url, options) => { refreshSignal = options.signal; return new Promise(resolve => { finishRefresh = resolve; }); });
  render(<RemoteDesktopPanel />);
  await screen.findByText('Synthetic helper unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh desktop status' }));
  act(() => setActiveEnvironment({ id: 'synthetic-no-desktop', label: 'Restricted host', capabilities: { desktopView: false } }));
  expect(refreshSignal.aborted).toBe(true);
  await act(async () => finishRefresh(reply(display)));
  expect(screen.getByText('Desktop · Restricted host')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Start viewing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /desktop status/ })).not.toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('treats an already missing desktop session as confirmed stopped', async () => {
  const base = apiFetch.getMockImplementation();
  apiFetch.mockImplementation((url, options) => options.method === 'DELETE'
    ? Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Desktop session not found or expired' }) })
    : base(url, options));
  render(<RemoteDesktopPanel />);
  await view();
  fireEvent.click(screen.getByRole('button', { name: 'Stop viewing' }));
  expect(await screen.findByRole('button', { name: 'Start viewing' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await view();
  expect(requests.filter(([url, options]) => url.endsWith('/sessions') && options.method === 'POST')).toHaveLength(2);
});

it('does not let an earlier viewing session’s failed input disable new control or block new input', async () => {
  const base = apiFetch.getMockImplementation();
  let failOldInput;
  let finishNewInput;
  const input = [];
  let starts = 0;
  apiFetch.mockImplementation((url, options) => {
    if (url.endsWith('/sessions') && options.method === 'POST') return Promise.resolve(reply({ ...session, id: `synthetic-session-${++starts}` }));
    if (url.endsWith('/input')) {
      input.push([url, options.body]);
      if (input.length === 1) return new Promise((_, reject) => { failOldInput = reject; });
      if (input.length === 2) return new Promise(resolve => { finishNewInput = resolve; });
    }
    return base(url, options);
  });
  render(<RemoteDesktopPanel />);
  fireEvent.keyDown(await view(), { key: 'a', code: 'KeyA' });
  fireEvent.click(screen.getByRole('button', { name: 'Stop viewing' }));
  const image = await view();
  fireEvent.keyDown(image, { key: 'b', code: 'KeyB' });
  fireEvent.keyDown(image, { key: 'c', code: 'KeyC' });
  await act(async () => failOldInput(new Error('Synthetic old input failed')));
  expect(screen.getByLabelText('Enable remote keyboard and pointer control')).toBeChecked();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(input).toHaveLength(2);
  await act(async () => finishNewInput({ ok: true, status: 204 }));
  expect(input).toEqual([
    ['/api/desktop/sessions/synthetic-session-1/input', { kind: 'key', key: 'KeyA', modifiers: [] }],
    ['/api/desktop/sessions/synthetic-session-2/input', { kind: 'key', key: 'KeyB', modifiers: [] }],
    ['/api/desktop/sessions/synthetic-session-2/input', { kind: 'key', key: 'KeyC', modifiers: [] }],
  ]);
});
