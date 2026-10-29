import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { supervisedInputScope } from '../utils/supervisedRawInputController';
import { apiFetch } from '../utils/api';
import { RawInputRecovery } from './RawInputRecovery';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/supervisedInputTransaction', () => ({ supervisedInputTransaction: callback => Promise.resolve().then(callback) }));
const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
const sessionId = 'ss-raw-review';
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setUser({ id: 'raw-review-owner' }); setEnvironmentIdentity('raw-review-owner', window.location.origin);
  vi.stubGlobal('navigator', { ...navigator, locks: { request: (_name, _options, callback) => callback() } });
  apiFetch.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); clearTokens(true); setEnvironmentIdentity(null); localStorage.clear(); sessionStorage.clear(); });

it('hides recovery on an older server when there are no pending operations', async () => {
  apiFetch.mockResolvedValue(response(404, {}));
  render(<RawInputRecovery />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument();
});

it('does not probe unsupported recovery routes on a paired environment without pending input', async () => {
  setActiveEnvironment({ id: 'old-paired-fixture' });
  apiFetch.mockResolvedValue(response(403, {}));
  render(<RawInputRecovery />);
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(apiFetch).not.toHaveBeenCalled();
});

it('ignores compaction of settled records while responding to pending changes in another tab', async () => {
  apiFetch.mockResolvedValue(response(404, {}));
  render(<RawInputRecovery />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  const key = `scope:supervisedRawInput:v2:${sessionId}:${requestId}`;
  const settled = JSON.stringify({ stage: 'settled' });
  fireEvent(window, new StorageEvent('storage', { key, oldValue: settled, newValue: null }));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  fireEvent(window, new StorageEvent('storage', { key, oldValue: null, newValue: JSON.stringify({ stage: 'issued' }) }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
});

it('requires explicit review and clears a saved uncertain operation only after server confirmation', async () => {
  const store = supervisedInputScope(sessionId).store;
  await store.reserve({ requestId, deliveryToken: 'token' }); await store.markSending(requestId);
  let reviewed = false;
  apiFetch.mockImplementation(async (url, options = {}) => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: reviewed ? [] : [{ sessionId, requestId, status: 'uncertain' }], nextCursor: null });
    if (url.endsWith('/review')) { reviewed = true; return response(200, { sessionId, requestId, status: 'reviewed' }); }
    if (url.endsWith(`/${requestId}`)) return response(200, { sessionId, requestId, status: reviewed ? 'reviewed' : 'uncertain' });
    throw new Error(`Unexpected ${url} ${options.method}`);
  });
  render(<RawInputRecovery sessions={[{ id: sessionId, title: 'Synthetic thread' }]} />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent('Synthetic thread: Delivery uncertain');
  expect(screen.getByRole('button', { name: 'Continue after review' })).toBeDisabled();
  expect(apiFetch.mock.calls.some(([url]) => url.endsWith('/review'))).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument());
  expect(supervisedInputScope(sessionId).store.read()).toBeNull();
  expect(apiFetch.mock.calls.filter(([url]) => url.endsWith('/review'))).toHaveLength(1);
});

it('keeps a missing receipt and identity for review instead of assuming it was not delivered', async () => {
  const store = supervisedInputScope(sessionId).store;
  await store.reserve({ requestId, deliveryToken: 'token' }); await store.markSending(requestId);
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: [], nextCursor: null });
    return response(404, {});
  });
  render(<RawInputRecovery />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent('Delivery uncertain');
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Input receipt unavailable');
  expect(supervisedInputScope(sessionId).store.read().requestId).toBe(requestId);
});

it('recovers a delivery confirmed after a delayed reopen and acknowledges it before settling', async () => {
  const store = supervisedInputScope(sessionId).store;
  await store.reserve({ requestId, deliveryToken: 'token' }); await store.markSending(requestId);
  let acknowledged = false;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: acknowledged ? [] : [{ sessionId, requestId, status: 'delivered' }], nextCursor: null });
    if (url.endsWith('/review')) { acknowledged = true; return response(200, { sessionId, requestId, status: 'acknowledged' }); }
    if (url.endsWith(`/${requestId}`)) return response(200, { sessionId, requestId, status: acknowledged ? 'acknowledged' : 'delivered' });
    throw new Error(`Unexpected ${url}`);
  });
  render(<RawInputRecovery />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent('Delivery confirmed');
  expect(store.read().requestId).toBe(requestId);
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument());
  expect(store.read()).toBeNull();
});

it('can review a server-retained operation after its session has been deleted', async () => {
  let reviewed = false;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: reviewed ? [] : [{ sessionId, requestId, status: 'issued' }], nextCursor: null });
    if (url.endsWith('/review')) { reviewed = true; return response(200, { sessionId, requestId, status: 'reviewed' }); }
    if (url.endsWith(`/${requestId}`)) return response(200, { sessionId, requestId, status: 'issued' });
    throw new Error(`Unexpected ${url}`);
  });
  render(<RawInputRecovery sessions={[]} />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent(`${sessionId}: Delivery not confirmed`);
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument());
});

it('recovers server-retained input after restart with no browser-local record', async () => {
  let reviewed = false;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1, enabled: false });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: reviewed ? [] : [{ sessionId, requestId, status: 'uncertain' }], nextCursor: null });
    if (url.endsWith('/review')) { reviewed = true; return response(200, { sessionId, requestId, status: 'reviewed' }); }
    if (url.endsWith(`/${requestId}`)) return response(200, { sessionId, requestId, status: 'uncertain' });
    throw new Error(`Unexpected ${url}`);
  });
  render(<RawInputRecovery />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent('Delivery uncertain');
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument());
});

it('can settle an issued operation even when its saved delivery token has expired', async () => {
  const store = supervisedInputScope(sessionId).store;
  await store.reserve({ requestId, deliveryToken: 'expired-token' });
  let reviewed = false;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: reviewed ? [] : [{ sessionId, requestId, status: 'issued' }], nextCursor: null });
    if (url.endsWith('/review')) { reviewed = true; return response(200, { sessionId, requestId, status: 'reviewed' }); }
    if (url.endsWith(`/${requestId}`)) return response(200, { sessionId, requestId, status: 'issued' });
    throw new Error(`Unexpected ${url}`);
  });
  render(<RawInputRecovery />);
  expect(await screen.findByRole('region', { name: 'Input delivery review' })).toHaveTextContent('Delivery not confirmed');
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked the terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue after review' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Input delivery review' })).not.toBeInTheDocument());
  expect(supervisedInputScope(sessionId).store.read()).toBeNull();
});
