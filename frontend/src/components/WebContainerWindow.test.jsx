import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ auth: { user: { id: 'runner-owner' }, loading: false }, props: null }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => state.auth, AuthProvider: ({ children }) => children }));
vi.mock('./LoginPage', () => ({ default: () => <p>Existing sign-in form</p> }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/webcontainer', async original => ({ ...await original(), disposeWebContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./WebContainerPreview', () => ({ WebContainerPreview: props => { state.props = props; return <div data-testid="running-project">Runtime project</div>; } }));
import { setTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { createWebContainerLaunch } from '../utils/webcontainerWindow';
import { apiFetch } from '../utils/api';
import { disposeWebContainer } from '../utils/webcontainer';
import { WebContainerRunner } from './WebContainerWindow';
const files = { 'package.json': { file: { contents: '{}' } }, 'main.js': { file: { contents: 'synthetic source' } } };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

beforeEach(() => {
  localStorage.clear(); setActiveEnvironment(null); setTokens('synthetic-access', 'synthetic-refresh'); setUser({ id: 'runner-owner' }); setEnvironmentIdentity('runner-owner');
  state.auth = { user: { id: 'runner-owner' }, loading: false }; state.props = null;
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('crossOriginIsolated', true);
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/156' });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key, _opts, run) => run() } });
  apiFetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ files, omissions: { total: 0, entries: [], truncated: false } }))); 
  disposeWebContainer.mockClear();
  const launch = createWebContainerLaunch({ projectPath: '/synthetic/pinned-project', startCommand: 'npm run serve' });
  window.history.replaceState(null, '', launch.href);
});
const ready = async () => waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());

describe('isolated runner', () => {
  it('waits for auth, pins a one-use launch and starts only after Run', async () => {
    state.auth.loading = true;
    const view = render(<WebContainerRunner />);
    expect(apiFetch).not.toHaveBeenCalled();
    state.auth = { ...state.auth, loading: false }; view.rerender(<WebContainerRunner />); await ready();
    expect(screen.getByText('/synthetic/pinned-project')).toBeInTheDocument();
    expect(screen.getByText('npm run serve')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('running-project')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/api/webcontainer/files?path=%2Fsynthetic%2Fpinned-project', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.props).toMatchObject({ projectFiles: files, startCommand: 'npm run serve', isScopeCurrent: expect.any(Function) });
  });
  it('requires visible review of bounded omission metadata before execution', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ files, omissions: { total: 2, entries: [{ path: '.env', reason: 'Private configuration or key material' }, { path: '.npmrc', reason: 'Private configuration or key material' }], truncated: false } })));
    render(<WebContainerRunner />); await ready(); fireEvent.click(screen.getByText('Run'));
    expect(await screen.findByText('.env')).toBeInTheDocument();
    expect(screen.queryByTestId('running-project')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Run exported files'));
    expect(screen.getByTestId('running-project')).toBeInTheDocument();
  });
  it('discards a successful file response if stored owner changes before JSON resolves', async () => {
    const json = deferred(); apiFetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) { json.promise.then(value => { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); }); } }))); 
    render(<WebContainerRunner />); await ready(); fireEvent.click(screen.getByText('Run'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    localStorage.setItem('terminal_auth_session', 'different-owner-epoch');
    await act(async () => json.resolve({ files }));
    expect(screen.queryByTestId('running-project')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/account|environment/i);
    expect(disposeWebContainer).toHaveBeenCalled();
  });
  it('allows same-session rotation but revokes direct environment changes and clears the runtime', async () => {
    render(<WebContainerRunner />); await ready(); fireEvent.click(screen.getByText('Run'));
    await screen.findByTestId('running-project');
    localStorage.setItem('terminal_access_token', 'rotated-synthetic');
    expect(state.props.isScopeCurrent()).toBe(true);
    localStorage.setItem(`identity:${encodeURIComponent(window.location.origin)}:runner-owner:selectedEnvironment`, 'paired');
    await act(async () => { expect(state.props.isScopeCurrent()).toBe(false); });
    expect(screen.queryByTestId('running-project')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/account|environment/i);
  });
  it('Stop clears project state and retires the singleton; Run fetches a fresh projection', async () => {
    render(<WebContainerRunner />); await ready(); fireEvent.click(screen.getByText('Run'));
    await screen.findByTestId('running-project');
    fireEvent.click(screen.getByText('Stop')); await ready();
    expect(screen.queryByTestId('running-project')).not.toBeInTheDocument();
    expect(disposeWebContainer).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Run')); await screen.findByTestId('running-project');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
  it('offers existing login and honest missing-header recovery without boot or file reads', async () => {
    state.auth = { user: null, loading: false };
    const view = render(<WebContainerRunner />);
    expect(screen.getByText('Existing sign-in form')).toBeInTheDocument();
    state.auth.user = { id: 'runner-owner' }; vi.stubGlobal('crossOriginIsolated', false); view.rerender(<WebContainerRunner />);
    expect(screen.getByRole('alert')).toHaveTextContent(/isolat|header/i);
    expect(screen.getByRole('link', { name: 'Return to normal app' })).toHaveAttribute('href', '/');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
