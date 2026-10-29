import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProviderConnectionsPanel } from './ProviderConnectionsPanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
const apiFetch = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ generation: 0, listeners: new Set() }));
vi.mock('../utils/api', () => ({ apiFetch }));
vi.mock('../utils/auth', () => ({
  captureAuthScope: () => ({ generation: auth.generation, home: 'https://home.test', userId: 'synthetic-owner' }),
  isAuthScopeCurrent: scope => scope.generation === auth.generation,
  subscribeAuth: listener => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); },
}));
const P = '10000000-0000-4000-8000-000000000001';
const R = '20000000-0000-4000-8000-000000000001';
const O = '60000000-0000-4000-8000-000000000001';
const J = '50000000-0000-4000-8000-000000000001';
const profile = { profileId: P, revision: R, provider: 'actual', mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', authMode: 'none', clusterId: null, activation: 'ready' };
const response = (value, status = 200) => ({ ok: status < 300, status, json: async () => value });
const receipt = (saved = profile) => ({ profileId: P, operationId: O, savedRevision: R, settingsSaved: true, cleanupConfirmed: true, deleted: false, profile: saved });
const job = status => ({ requestId: J, profileId: P, status, cleanupPending: status === 'running', cancelRequested: ['cancelling', 'cancelled'].includes(status), cancelConfirmed: status === 'cancelled', models: null, error: null });
async function setup(profiles = []) {
  apiFetch.mockResolvedValueOnce(response({ profiles }));
  render(<ProviderConnectionsPanel />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
}
beforeEach(() => {
  vi.restoreAllMocks(); apiFetch.mockReset(); auth.generation = 0;
  setActiveEnvironment(null);
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(O).mockReturnValueOnce(P).mockReturnValue(J);
});

it.each([true, false])('reconciles historical cleanup-pending receipts with the current list (immediate confirmation %s)', async immediate => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  const historical = { ...profile, activation: 'cleanup-pending' };
  apiFetch.mockResolvedValueOnce(response({ ...receipt(historical), cleanupConfirmed: immediate }))
    .mockResolvedValueOnce(response({ profiles: [immediate ? profile : historical] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText(immediate ? 'Connection saved.' : 'Connection saved. Previous work is still stopping.');
  if (!immediate) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous work' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Discover models' })).toBeDisabled();
    apiFetch.mockResolvedValueOnce(response(receipt(historical))).mockResolvedValueOnce(response({ profiles: [profile] }));
    fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
    await screen.findByText('Previous connection work has stopped.');
  }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover models' })).toBeEnabled());
  expect(screen.queryByText(/waiting for previous work to stop/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check previous work' })).not.toBeInTheDocument();
});

it('does not start discovery when loading or saving a profile', async () => {
  await setup();
  apiFetch.mockResolvedValueOnce(response(receipt())).mockResolvedValueOnce(response({ profiles: [profile] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Connection saved.');
  expect(apiFetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
    ['/api/agent/connections', undefined], [`/api/agent/connections/${P}`, 'PUT'], ['/api/agent/connections', undefined],
  ]);
  expect(apiFetch.mock.calls[1][1].body.expectedRevision).toBeNull();
});
it('masks a new key and retries an uncertain save with the exact original body and operation', async () => {
  await setup();
  fireEvent.change(screen.getByLabelText('Provider and mode'), { target: { value: 'actual:relay' } });
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: 'https://api.actual.inc/v1' } });
  fireEvent.change(screen.getByLabelText('Bearer key'), { target: { value: 'synthetic-private-key' } });
  expect(screen.getByLabelText('Bearer key')).toHaveAttribute('type', 'password');
  apiFetch.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  const retry = await screen.findByRole('button', { name: 'Retry same save' });
  expect(screen.getByLabelText('API endpoint')).toBeDisabled();
  const original = apiFetch.mock.calls[1][1].body;
  const relay = { ...profile, mode: 'relay', authMode: 'bearer', baseUrl: 'https://api.actual.inc/v1' };
  apiFetch.mockResolvedValueOnce(response(receipt(relay))).mockResolvedValueOnce(response({ profiles: [relay] }));
  fireEvent.click(retry);
  await screen.findByText('Connection saved.');
  expect(apiFetch.mock.calls[2][1].body).toBe(original);
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('');
  expect(screen.queryByText('synthetic-private-key')).not.toBeInTheDocument();
});
it('retains a known rejected draft without silently overwriting a changed saved revision', async () => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: 'http://127.0.0.1:9999/v1' } });
  apiFetch.mockResolvedValueOnce(response({}, 409));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('API endpoint')).toHaveValue('http://127.0.0.1:9999/v1');
  expect(apiFetch.mock.calls[1][1].body.expectedRevision).toBe(R);
  expect(screen.queryByRole('button', { name: 'Retry same save' })).not.toBeInTheDocument();
});
it('polls a real job contract and preserves unknown model capabilities in its presentation', async () => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(J);
  apiFetch.mockResolvedValueOnce(response(job('running'))).mockResolvedValueOnce(response({ ...job('succeeded'), cleanupPending: false,
    models: [{ id: 'own-model', label: 'Own model', loaded: null, imageInput: null, contextWindow: null }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
  await screen.findByText('Own model');
  expect(screen.getByText('Loaded: unknown · Images: unknown · Context: unknown')).toBeInTheDocument();
  expect(apiFetch.mock.calls[1][1].body).toEqual({ requestId: J });
});
it('keeps cancellation unconfirmed until a later joined result', async () => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(J);
  apiFetch.mockResolvedValueOnce(response(job('running')));
  fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
  const cancel = await screen.findByRole('button', { name: 'Cancel discovery' });
  apiFetch.mockResolvedValueOnce(response({ ...job('cancelling'), cleanupPending: true })).mockResolvedValueOnce(response({ ...job('cancelled'), cleanupPending: false }));
  fireEvent.click(cancel);
  await screen.findByText('Status: cancelling · cleanup unconfirmed');
  expect(screen.queryByText(/cancellation confirmed/)).not.toBeInTheDocument();
  await screen.findByText('Status: cancelled · cancellation confirmed');
});
it('does not access Home or a paired device while a remote environment is selected', async () => {
  setActiveEnvironment({ id: 'synthetic-paired' });
  render(<ProviderConnectionsPanel />);
  expect(screen.getByText(/Select Home/)).toBeInTheDocument();
  expect(apiFetch).not.toHaveBeenCalled();
});
it('drops a stale response and secrets after an account change', async () => {
  let resolve;
  apiFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<ProviderConnectionsPanel />);
  apiFetch.mockResolvedValueOnce(response({ profiles: [] }));
  await act(async () => { auth.generation++; auth.listeners.forEach(listener => listener()); });
  await act(async () => { resolve(response({ profiles: [profile] })); });
  expect(screen.queryByRole('option', { name: /Actual ·/ })).not.toBeInTheDocument();
});
it('retires a held load across a batched Home to paired to Home transition', async () => {
  let resolve;
  apiFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<ProviderConnectionsPanel />);
  const originalSignal = apiFetch.mock.calls[0][1].signal;
  apiFetch.mockResolvedValueOnce(response({ profiles: [] }));
  await act(async () => {
    setActiveEnvironment({ id: 'synthetic-paired' });
    setActiveEnvironment(null);
  });
  expect(originalSignal.aborted).toBe(true);
  await act(async () => { resolve(response({ profiles: [profile] })); });
  expect(screen.queryByRole('option', { name: /Actual ·/ })).not.toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
it('does not adopt a held save after batched Home to paired to Home transitions', async () => {
  await setup();
  let resolve;
  apiFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  const originalSignal = apiFetch.mock.calls[1][1].signal;
  apiFetch.mockResolvedValueOnce(response({ profiles: [] }));
  await act(async () => {
    setActiveEnvironment({ id: 'synthetic-paired' });
    setActiveEnvironment(null);
  });
  expect(originalSignal.aborted).toBe(true);
  await act(async () => { resolve(response(receipt())); });
  expect(screen.queryByText('Connection saved.', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Actual ·/ })).not.toBeInTheDocument();
});

it('labels an older connection inventory after selecting a different saved profile', async () => {
  const other = { ...profile, profileId: '10000000-0000-4000-8000-000000000002', baseUrl: 'http://127.0.0.1:9999/v1' };
  await setup([profile, other]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(J);
  apiFetch.mockResolvedValueOnce(response({ ...job('succeeded'), cleanupPending: false, models: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
  await screen.findByText('Status: succeeded');
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: other.profileId } });
  expect(screen.getByText('This discovery belongs to a previously selected connection.')).toBeInTheDocument();
});

it('keeps the original in-flight bearer save during a same-account credential rotation', async () => {
  await setup();
  fireEvent.change(screen.getByLabelText('Provider and mode'), { target: { value: 'actual:relay' } });
  fireEvent.change(screen.getByLabelText('Bearer key'), { target: { value: 'synthetic-rotating-key' } });
  let resolve;
  apiFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  const originalSignal = apiFetch.mock.calls[1][1].signal;
  const originalBody = apiFetch.mock.calls[1][1].body;
  await act(async () => { auth.listeners.forEach(listener => listener('rotation')); });
  expect(originalSignal.aborted).toBe(false);
  expect(screen.getByLabelText('Bearer key')).toHaveValue('synthetic-rotating-key');
  expect(apiFetch).toHaveBeenCalledTimes(2);
  const relay = { ...profile, mode: 'relay', authMode: 'bearer', baseUrl: 'https://api.actual.inc/v1' };
  apiFetch.mockResolvedValueOnce(response({ profiles: [relay] }));
  await act(async () => { resolve(response(receipt(relay))); });
  expect(screen.getByText('Connection saved.', { exact: true })).toBeInTheDocument();
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('');
  expect(apiFetch.mock.calls[1][1].body).toBe(originalBody);
});

it.each(['ready', 'cleanup-pending'])('retries only the list after a committed %s receipt refresh fails and preserves a new draft key', async activation => {
  const relay = { ...profile, mode: 'relay', authMode: 'bearer', baseUrl: 'https://api.actual.inc/v1' };
  await setup([relay]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  fireEvent.change(screen.getByLabelText('Replacement bearer key (optional)'), { target: { value: 'synthetic-submitted-key' } });
  apiFetch.mockResolvedValueOnce(response(receipt({ ...relay, activation })))
    .mockRejectedValueOnce(new Error('Synthetic refresh failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Synthetic refresh failed');
  expect(screen.queryByRole('button', { name: 'Retry same save' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Discover models' })).toBeDisabled();
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Replacement bearer key (optional)'), { target: { value: 'synthetic-unsaved-key' } });
  apiFetch.mockResolvedValueOnce(response({ profiles: [relay] }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection refresh' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry connection refresh' })).not.toBeInTheDocument());
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('synthetic-unsaved-key');
  expect(apiFetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
    ['/api/agent/connections', undefined], [`/api/agent/connections/${P}`, 'PUT'],
    ['/api/agent/connections', undefined], ['/api/agent/connections', undefined],
  ]);
});

it('uses a newer current revision after checking historical cleanup without replacing an unsaved draft', async () => {
  const newer = { ...profile, revision: '20000000-0000-4000-8000-000000000002', baseUrl: 'http://127.0.0.1:9999/v1' };
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  const historical = { ...profile, activation: 'cleanup-pending' };
  apiFetch.mockResolvedValueOnce(response({ ...receipt(historical), cleanupConfirmed: false }))
    .mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous work' })).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(newer.baseUrl);
  const draftUrl = 'http://127.0.0.1:7777/v1';
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: draftUrl } });
  apiFetch.mockResolvedValueOnce(response(receipt(historical))).mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(draftUrl);
  apiFetch.mockResolvedValueOnce(response({}, 409));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('alert');
  expect(apiFetch.mock.calls.at(-1)[1].body).toEqual({
    operationId: P, expectedRevision: newer.revision, provider: 'actual', mode: 'local',
    baseUrl: draftUrl, auth: { type: 'none' }, clusterId: null,
  });
});

it.each(['account', 'environment'])('discards a held reconciliation after an %s lifetime change', async change => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  let finish;
  apiFetch.mockResolvedValueOnce(response(receipt({ ...profile, activation: 'cleanup-pending' })))
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  const signal = apiFetch.mock.calls.at(-1)[1].signal;
  apiFetch.mockResolvedValueOnce(response({ profiles: [] }));
  await act(async () => {
    if (change === 'account') { auth.generation++; auth.listeners.forEach(listener => listener()); }
    else { setActiveEnvironment({ id: 'synthetic-paired' }); setActiveEnvironment(null); }
  });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(response({ profiles: [profile] })); });
  expect(screen.queryByRole('option', { name: /Actual ·/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Discover models' })).not.toBeInTheDocument();
});

it('reconciles a superseded deletion with a newer current profile instead of treating the receipt as current', async () => {
  const newer = { ...profile, revision: '20000000-0000-4000-8000-000000000003', baseUrl: 'http://127.0.0.1:9999/v1' };
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  apiFetch.mockResolvedValueOnce(response({ ...receipt(), deleted: true, superseded: true, profile: null }))
    .mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover models' })).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(newer.baseUrl);
  expect(apiFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'DELETE', body: { operationId: O, expectedRevision: R } }));
});

it('offers a list-only retry when reconciliation after a confirmed operation check fails', async () => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  const historical = { ...profile, activation: 'cleanup-pending' };
  apiFetch.mockResolvedValueOnce(response({ ...receipt(historical), cleanupConfirmed: false }))
    .mockResolvedValueOnce(response({ profiles: [historical] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous work' })).toBeEnabled());
  apiFetch.mockResolvedValueOnce(response(receipt(historical))).mockRejectedValueOnce(new Error('Synthetic check refresh failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
  await screen.findByText('Synthetic check refresh failed');
  expect(screen.queryByRole('button', { name: 'Check previous work' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Discover models' })).toBeDisabled();
  apiFetch.mockResolvedValueOnce(response({ profiles: [profile] }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection refresh' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover models' })).toBeEnabled());
  expect(apiFetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
    ['/api/agent/connections', undefined], [`/api/agent/connections/${P}`, 'PUT'],
    ['/api/agent/connections', undefined], [`/api/agent/connections/${P}/operations/${O}`, undefined],
    ['/api/agent/connections', undefined], ['/api/agent/connections', undefined],
  ]);
});

it.each(['check', 'retry'])('keeps a dirty draft in conflict after %s reconciles a newer credential revision', async source => {
  const relay = { ...profile, mode: 'relay', authMode: 'bearer', baseUrl: 'https://api.actual.inc/v1', clusterId: 'original-cluster' };
  const newer = { ...relay, revision: '20000000-0000-4000-8000-000000000004', clusterId: 'concurrent-cluster' };
  await setup([relay]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  apiFetch.mockResolvedValueOnce(response({ ...receipt(relay), cleanupConfirmed: source !== 'check' }));
  if (source === 'check') apiFetch.mockResolvedValueOnce(response({ profiles: [relay] }));
  else apiFetch.mockRejectedValueOnce(new Error('Synthetic list unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  const action = await screen.findByRole('button', { name: source === 'check' ? 'Check previous work' : 'Retry connection refresh' });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Cluster ID (optional)'), { target: { value: 'draft-cluster' } });
  fireEvent.change(screen.getByLabelText('Replacement bearer key (optional)'), { target: { value: 'synthetic-unsaved-key' } });
  if (source === 'check') apiFetch.mockResolvedValueOnce(response(receipt(relay)));
  apiFetch.mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(action);
  await waitFor(() => expect(screen.getByLabelText('Cluster ID (optional)')).toBeEnabled());
  expect(screen.getByLabelText('Cluster ID (optional)')).toHaveValue('draft-cluster');
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('synthetic-unsaved-key');
  expect(screen.getByRole('alert')).toHaveTextContent('changed or was deleted elsewhere');
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete connection' })).toBeDisabled();
  const calls = apiFetch.mock.calls.length;
  fireEvent.submit(screen.getByRole('form', { name: 'Connection settings' }));
  expect(apiFetch).toHaveBeenCalledTimes(calls);
  apiFetch.mockRejectedValueOnce(new Error('Synthetic reload unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await screen.findByText('Synthetic reload unavailable');
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('synthetic-unsaved-key');
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  apiFetch.mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
  expect(screen.getByLabelText('Cluster ID (optional)')).toHaveValue('concurrent-cluster');
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('');
  apiFetch.mockResolvedValueOnce(response({}, 409));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('alert');
  expect(apiFetch.mock.calls.at(-1)[1].body).toEqual(expect.objectContaining({ expectedRevision: newer.revision, clusterId: 'concurrent-cluster', auth: { type: 'bearer', credentialAction: 'keep' } }));
});

it('keeps an externally deleted dirty draft bound to its identity until explicit reload', async () => {
  await setup([profile]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  apiFetch.mockResolvedValueOnce(response({ ...receipt(), cleanupConfirmed: false }))
    .mockResolvedValueOnce(response({ profiles: [profile] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous work' })).toBeEnabled());
  const draftUrl = 'http://127.0.0.1:7777/v1';
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: draftUrl } });
  apiFetch.mockResolvedValueOnce(response({ ...receipt(), cleanupConfirmed: false })).mockResolvedValueOnce(response({ profiles: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
  await waitFor(() => expect(screen.getByLabelText('API endpoint')).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(draftUrl);
  expect(screen.getByLabelText('Saved connection')).toHaveValue(P);
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  const calls = apiFetch.mock.calls.length;
  fireEvent.submit(screen.getByRole('form', { name: 'Connection settings' }));
  expect(apiFetch).toHaveBeenCalledTimes(calls);
  // Reverting fields alone must not rebase the draft on a later operation check.
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: profile.baseUrl } });
  apiFetch.mockResolvedValueOnce(response(receipt())).mockResolvedValueOnce(response({ profiles: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Check previous work' })).not.toBeInTheDocument());
  expect(screen.getByRole('alert')).toHaveTextContent('changed or was deleted elsewhere');
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  apiFetch.mockResolvedValueOnce(response({ profiles: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
  expect(screen.getByLabelText('Saved connection')).toHaveValue('');
  expect(screen.getByLabelText('API endpoint')).toHaveValue('http://127.0.0.1:8080/v1');
});

it('does not send an old unauthenticated form against a concurrently added bearer credential', async () => {
  const local = { ...profile, provider: 'lmstudio' };
  const newer = { ...local, revision: '20000000-0000-4000-8000-000000000005', authMode: 'bearer' };
  await setup([local]);
  fireEvent.change(screen.getByLabelText('Saved connection'), { target: { value: P } });
  apiFetch.mockResolvedValueOnce(response({ ...receipt(local), cleanupConfirmed: false }))
    .mockResolvedValueOnce(response({ profiles: [local] }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous work' })).toBeEnabled());
  const draftUrl = 'http://127.0.0.1:7777/v1';
  fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: draftUrl } });
  apiFetch.mockResolvedValueOnce(response(receipt(local))).mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Check previous work' }));
  await waitFor(() => expect(screen.getByLabelText('API endpoint')).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(draftUrl);
  expect(screen.getByLabelText('Authentication')).toHaveValue('none');
  expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled();
  const calls = apiFetch.mock.calls.length;
  fireEvent.submit(screen.getByRole('form', { name: 'Connection settings' }));
  expect(apiFetch).toHaveBeenCalledTimes(calls);
  apiFetch.mockResolvedValueOnce(response({ profiles: [newer] }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled());
  expect(screen.getByLabelText('API endpoint')).toHaveValue(newer.baseUrl);
  expect(screen.getByLabelText('Authentication')).toHaveValue('bearer');
  expect(screen.getByLabelText('Replacement bearer key (optional)')).toHaveValue('');
});
