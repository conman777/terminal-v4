import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from './auth';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { listUnsettledSupervisedInputs, sendRawInput, supervisedInputScope } from './supervisedRawInputController';
import { apiFetch } from './api';

vi.mock('./api', () => ({ apiFetch: vi.fn() }));
vi.mock('./supervisedInputTransaction', () => ({ supervisedInputTransaction: callback => Promise.resolve().then(callback) }));
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setUser({ id: 'raw-fixture-owner' }); setEnvironmentIdentity('raw-fixture-owner', window.location.origin);
  vi.stubGlobal('navigator', { ...navigator, locks: { request: (_name, _options, callback) => callback() } });
  apiFetch.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); clearTokens(true); setEnvironmentIdentity(null); localStorage.clear(); sessionStorage.clear(); });

it('uses the existing legacy path only when the capability is absent', async () => {
  apiFetch.mockResolvedValue(response(404, {}));
  const legacy = vi.fn().mockResolvedValue({ accepted: true });
  expect(await sendRawInput('ss-fixture', '\r', legacy)).toEqual({ accepted: true });
  expect(legacy).toHaveBeenCalledWith('ss-fixture', '\r');
});

it('uses legacy input for an ineligible recovered session only after checking unresolved receipts', async () => {
  apiFetch.mockImplementation(async url => {
    if (url === '/api/structured/input-capabilities') return response(200, { protocol: 1 });
    if (url === '/api/structured/sessions/ss-legacy/input-capabilities') return response(404, {});
    if (url === '/api/structured/input-receipts') return response(200, { receipts: [], nextCursor: null });
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn().mockResolvedValue({ accepted: true });
  expect(await sendRawInput('ss-legacy', '\r', legacy)).toEqual({ accepted: true });
  expect(legacy).toHaveBeenCalledWith('ss-legacy', '\r');
});

it('does not fall back for an ineligible session with a server-retained pending operation', async () => {
  apiFetch.mockImplementation(async url => {
    if (url === '/api/structured/input-capabilities') return response(200, { protocol: 1 });
    if (url === '/api/structured/sessions/ss-legacy/input-capabilities') return response(404, {});
    if (url === '/api/structured/input-receipts') return response(200, { receipts: [{ sessionId: 'ss-legacy', requestId, status: 'uncertain' }], nextCursor: null });
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn();
  await expect(sendRawInput('ss-legacy', '\r', legacy)).rejects.toThrow('needs review');
  expect(legacy).not.toHaveBeenCalled();
});

it('does not fall back when server recovery cannot be checked for an ineligible session', async () => {
  apiFetch.mockImplementation(async url => {
    if (url === '/api/structured/input-capabilities') return response(200, { protocol: 1 });
    if (url.endsWith('/input-capabilities')) return response(404, {});
    return response(503, {});
  });
  const legacy = vi.fn();
  await expect(sendRawInput('ss-legacy', '\r', legacy)).rejects.toThrow('recovery could not be checked');
  expect(legacy).not.toHaveBeenCalled();
});

it('does not downgrade an already supervised batch when the session becomes ineligible', async () => {
  apiFetch.mockImplementation(async url => response(url === '/api/structured/input-capabilities' ? 200 : 404, { protocol: 1 }));
  const legacy = vi.fn();
  await expect(sendRawInput('ss-legacy', 'x', legacy, { requireSupervision: true })).rejects.toThrow('no longer supports supervised input');
  expect(legacy).not.toHaveBeenCalled();
});

it('uses legacy input for a paired server without probing an older target', async () => {
  setActiveEnvironment({ id: 'paired-fixture', capabilities: { terminalInput: true } });
  const legacy = vi.fn().mockResolvedValue({ accepted: true });
  apiFetch.mockResolvedValue(response(403, {}));
  expect(await sendRawInput('ss-paired', '\r', legacy)).toEqual({ accepted: true });
  expect(apiFetch).not.toHaveBeenCalled();
  await expect(sendRawInput('ss-paired', '\r', legacy, { requireSupervision: true })).rejects.toThrow('no longer supports supervised input');
  expect(legacy).toHaveBeenCalledTimes(1);
});

it('does not use paired legacy input when a supervised local operation is pending', async () => {
  setActiveEnvironment({ id: 'paired-fixture', capabilities: { terminalInput: true } });
  const scope = supervisedInputScope('ss-paired');
  await scope.store.reserve({ requestId, deliveryToken: 'token' });
  const legacy = vi.fn();
  await expect(sendRawInput('ss-paired', '\r', legacy)).rejects.toThrow('needs review');
  expect(legacy).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
});

it('does not treat a local 403 as capability absence', async () => {
  apiFetch.mockResolvedValue(response(403, {}));
  const legacy = vi.fn();
  await expect(sendRawInput('ss-local', '\r', legacy)).rejects.toThrow('verify supervised input support');
  expect(legacy).not.toHaveBeenCalled();
});

it('allows installed-disabled legacy input only after confirming there are no server holds', async () => {
  apiFetch.mockImplementation(async url => url.endsWith('/input-capabilities')
    ? response(200, { protocol: 1, enabled: false }) : response(200, { receipts: [], nextCursor: null }));
  const legacy = vi.fn().mockResolvedValue({ accepted: true });
  expect(await sendRawInput('ss-fixture', '\r', legacy)).toEqual({ accepted: true });
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(apiFetch.mock.calls.map(([url]) => url)).toContain('/api/structured/input-receipts');
});

it('blocks installed-disabled legacy input while a fresh browser sees a server hold', async () => {
  apiFetch.mockImplementation(async url => url.endsWith('/input-capabilities')
    ? response(200, { protocol: 1, enabled: false }) : response(200, { receipts: [{ sessionId: 'ss-fixture', requestId, status: 'uncertain' }], nextCursor: null }));
  const legacy = vi.fn();
  await expect(sendRawInput('ss-fixture', '\r', legacy)).rejects.toThrow('needs review');
  expect(legacy).not.toHaveBeenCalled();
});

it('never sends a buffered supervised batch through a downgraded legacy server', async () => {
  apiFetch.mockResolvedValue(response(404, {}));
  const legacy = vi.fn();
  await expect(sendRawInput('ss-fixture', 'ab', legacy, { requireSupervision: true })).rejects.toThrow('no longer supports supervised input');
  expect(legacy).not.toHaveBeenCalled();
});

it('does not send a legacy keystroke individually if the backend upgrades to supervised input', async () => {
  apiFetch.mockResolvedValue(response(200, { protocol: 1 }));
  const changed = vi.fn(), legacy = vi.fn();
  window.addEventListener('supervised-raw-input-capability-changed', changed);
  try {
    await expect(sendRawInput('ss-fixture', 'a', legacy, { requireLegacy: true })).rejects.toThrow('input mode changed');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
  } finally { window.removeEventListener('supervised-raw-input-capability-changed', changed); }
});

it('sends a protected operation only through the new endpoint', async () => {
  apiFetch.mockImplementation(async (url, options = {}) => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: [], nextCursor: null });
    if (url.endsWith('/input-operation')) return response(200, { protocol: 1, requestId, deliveryToken: 'token' });
    if (url.endsWith('/supervised-input')) return response(202, { status: 'accepted', outcome: 'delivered', requestId: options.body.requestId });
    if (url.endsWith('/review')) return response(200, { sessionId: 'ss-fixture', requestId, status: 'acknowledged' });
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn();
  expect(await sendRawInput('ss-fixture', '\r', legacy)).toEqual({ accepted: true, requestId });
  expect(legacy).not.toHaveBeenCalled();
  expect(apiFetch.mock.calls.find(([url]) => url.endsWith('/supervised-input'))[1].body).toEqual({ text: '\r', fallbackToMessage: false, requestId, deliveryToken: 'token' });
});

it('does not fall back after a protected endpoint disappears or an outcome is lost', async () => {
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: [], nextCursor: null });
    if (url.endsWith('/input-operation')) return response(200, { protocol: 1, requestId, deliveryToken: 'token' });
    if (url.endsWith('/supervised-input')) return response(404, {});
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn();
  await expect(sendRawInput('ss-fixture', '\r', legacy)).rejects.toThrow('could not be confirmed');
  await expect(sendRawInput('ss-fixture', '\r', legacy)).rejects.toThrow('needs review');
  expect(legacy).not.toHaveBeenCalled();
  expect(apiFetch.mock.calls.filter(([url]) => url.endsWith('/supervised-input'))).toHaveLength(1);
});

it('uses the server hold and durable recovery when browser locking is unavailable', async () => {
  vi.stubGlobal('navigator', {});
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: [], nextCursor: null });
    if (url.endsWith('/input-operation')) return response(200, { protocol: 1, requestId, deliveryToken: 'token' });
    if (url.endsWith('/supervised-input')) return response(409, { outcome: 'uncertain', requestId });
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn();
  await expect(sendRawInput('ss-fixture', '\r', legacy)).rejects.toThrow('could not be confirmed');
  await expect(sendRawInput('ss-fixture', '\r', legacy)).rejects.toThrow('needs review');
  expect(apiFetch.mock.calls.filter(([url]) => url.endsWith('/supervised-input'))).toHaveLength(1);
  expect(Object.keys(localStorage).some(key => key.includes('supervisedRawInput:v2:'))).toBe(true);
  expect(Object.keys(sessionStorage).some(key => key.includes('supervisedRawInput:v2:'))).toBe(false);
  expect(legacy).not.toHaveBeenCalled();
});

it('serializes concurrent calls in one tab without Web Locks and does not repeat uncertain input', async () => {
  vi.stubGlobal('navigator', {});
  let status = 'none', finishSend;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: status === 'uncertain' ? [{ sessionId: 'ss-parallel', requestId, status }] : [], nextCursor: null });
    if (url.endsWith('/input-operation')) return response(200, { protocol: 1, requestId, deliveryToken: 'token' });
    if (url.endsWith('/supervised-input')) return new Promise(resolve => { finishSend = () => { status = 'uncertain'; resolve(response(409, { outcome: 'uncertain', requestId })); }; });
    throw new Error(`Unexpected ${url}`);
  });
  const legacy = vi.fn();
  const first = sendRawInput('ss-parallel', '\r', legacy).catch(error => error.message);
  const second = sendRawInput('ss-parallel', '\r', legacy).catch(error => error.message);
  await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));
  expect(apiFetch.mock.calls.filter(([url]) => url.endsWith('/supervised-input'))).toHaveLength(1);
  finishSend();
  expect(await first).toContain('could not be confirmed');
  expect(await second).toContain('needs review');
  expect(apiFetch.mock.calls.filter(([url]) => url.endsWith('/supervised-input'))).toHaveLength(1);
});

it('reads every receipt page and rejects an invalid or non-advancing cursor', async () => {
  const first = { sessionId: 'ss-first', requestId, status: 'issued' };
  const second = { sessionId: 'ss-second', requestId: '018fdf56-2333-7abc-8abc-123456789abd', status: 'uncertain' };
  apiFetch.mockResolvedValueOnce(response(200, { receipts: [first], nextCursor: 12 })).mockResolvedValueOnce(response(200, { receipts: [second], nextCursor: null }));
  expect(await listUnsettledSupervisedInputs(new AbortController().signal)).toEqual([first, second]);
  expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/input-receipts', '/api/structured/input-receipts?after=12']);
  apiFetch.mockReset();
  apiFetch.mockResolvedValueOnce(response(200, { receipts: [first], nextCursor: 12 })).mockResolvedValueOnce(response(200, { receipts: [], nextCursor: 12 }));
  await expect(listUnsettledSupervisedInputs(new AbortController().signal)).rejects.toThrow('invalid');
});

it('recovers an unacknowledged delivered receipt after a later reopen', async () => {
  const delivered = { sessionId: 'ss-delayed', requestId, status: 'delivered' };
  apiFetch.mockResolvedValue(response(200, { receipts: [delivered], nextCursor: null }));
  expect(await listUnsettledSupervisedInputs(new AbortController().signal)).toEqual([delivered]);
});

it('compacts more than 10,000 settled operations using the server watermark before sending', async () => {
  const sessionId = 'ss-many-raw', scope = supervisedInputScope(sessionId);
  for (let index = 0; index < 10_001; index += 1) {
    const id = `018fdf56-2333-7abc-8abc-${index.toString(16).padStart(12, '0')}`;
    scope.storage.setItem(`supervisedRawInput:v2:${sessionId}:${id}`, JSON.stringify({ version: 2, sessionId, requestId: id, stage: 'settled' }));
  }
  const newerId = '018fdf56-2334-7abc-8abc-123456789abc';
  apiFetch.mockImplementation(async (url, options = {}) => {
    if (url.endsWith('/input-watermark')) return response(200, { protocol: 1, rejectBefore: 0x018fdf562334 });
    if (url.endsWith('/input-capabilities')) return response(200, { protocol: 1 });
    if (url.endsWith('/input-receipts')) return response(200, { receipts: [], nextCursor: null });
    if (url.endsWith('/input-operation')) return response(200, { protocol: 1, requestId: newerId, deliveryToken: 'token' });
    if (url.endsWith('/supervised-input')) return response(202, { status: 'accepted', outcome: 'delivered', requestId: options.body.requestId });
    if (url.endsWith('/review')) return response(200, { sessionId, requestId: newerId, status: 'acknowledged' });
    throw new Error(`Unexpected ${url}`);
  });
  expect(await sendRawInput(sessionId, '\r', vi.fn())).toEqual({ accepted: true, requestId: newerId });
  expect(scope.store.count()).toBe(1);
});
