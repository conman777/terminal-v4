import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, nativeBoundary, snapshot, intent, accepted, response, deferred, A, B, L1, L2, R1, R2, RAW, CANONICAL, SESSION, Socket } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { setTokens, setUser } from '../utils/auth';
import { useStructuredSession } from './useStructuredSession';
import { installImageTransport } from '../test/imageHookTransport';

const originalSocket = globalThis.WebSocket;
const mount = (active = false) => renderHook(() => useStructuredSession({ sessionId: SESSION.id, runtime: 'v4', active, aiType: SESSION.aiType, model: SESSION.model }));
let store, actionHTTP;
beforeEach(() => {
  resetFixture(); Socket.instances = []; globalThis.WebSocket = Socket;
  apiFetch.mockReset(); actionHTTP = installImageTransport(apiFetch); store = getComposerDraftStore(SESSION.id); store.setText(RAW); nativeBoundary(store);
});
afterEach(async () => { await cleanFixture(); globalThis.WebSocket = originalSocket; });
const callAction = async (hook, name) => { let result; await act(async () => { result = await hook.result.current[name]?.(); }); return result; };

describe('real structured hook consumes committed owned-image authority', () => {
  it('[H01] captures raw revision/IDs before await, projects once and POSTs the exact native serialized body after commit', async () => {
    const gate = deferred(), original = intent(); ports.native.prepareIntent.mockReturnValueOnce(gate.promise);
    actionHTTP.mockResolvedValue(response(accepted(original))); const hook = mount(); let sending;
    await act(async () => { sending = hook.result.current.sendMessage(RAW, [A]); await Promise.resolve(); });
    expect(actionHTTP).not.toHaveBeenCalled();
    expect(ports.native.prepareIntent).toHaveBeenCalledWith({ text: CANONICAL, attachments: [A], draftRevision: R1, localIds: [L1] });
    ports.native.publish(snapshot({ text: 'newer raw B', revision: R2, localIds: [L2] }));
    await act(async () => { gate.resolve(original); await sending; });
    const [url, options] = actionHTTP.mock.calls[0];
    expect(url).toBe(`/api/structured/sessions/${SESSION.id}/attachments/send`);
    expect(options.body).toBe(original.serializedBody); expect(options.headers['Content-Type']).toBe('application/json');
    expect(ports.native.confirmIntent).toHaveBeenCalledWith({ requestId: original.requestId, receipt: accepted(original) });
  });

  it('[H02] Check is GET-only with missing bytes and retries failed local confirmation without POST or new identity', async () => {
    const original = intent({ missingBytePins: [{ localId: L1, attachment: A }] });
    ports.native.publish(snapshot({ text: 'new B', revision: R2, localIds: [L2], pending: original }));
    ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error('Synthetic local quota'), { code: 'quota' }));
    actionHTTP.mockResolvedValue(response(accepted(original))); const hook = mount();
    const first = await callAction(hook, 'checkPendingMessage');
    expect(actionHTTP).toHaveBeenCalledTimes(1); expect(actionHTTP.mock.calls[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/requests/${original.requestId}`);
    expect(first).toMatchObject({ accepted: true, localCleanupPending: true, draftManaged: true });
    expect(ports.native.getBlob).not.toHaveBeenCalled();
    const second = await callAction(hook, 'checkPendingMessage');
    expect(second).toMatchObject({ accepted: true, draftManaged: true });
    expect(actionHTTP.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    expect(ports.native.prepareIntent).not.toHaveBeenCalled();
    expect(ports.native.getSnapshot()).toMatchObject({ text: 'new B', revision: R2, localIds: [L2] });
  });

  it('[H03] Retry GETs first then POSTs the immutable body and pins, preserving a different newer draft', async () => {
    const original = intent(); ports.native.publish(snapshot({ pending: original, text: 'newer B', revision: R2, localIds: [L2] }));
    actionHTTP.mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(accepted(original))); const hook = mount();
    const result = await callAction(hook, 'retryPendingMessage');
    expect(actionHTTP).toHaveBeenCalledTimes(2);
    expect(actionHTTP.mock.calls[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/requests/${original.requestId}`);
    expect(actionHTTP.mock.calls[1][1]).toMatchObject({ method: 'POST', body: original.serializedBody });
    expect(ports.native.getBlob).toHaveBeenCalledWith(L1);
    expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(result).toMatchObject({ accepted: true, draftManaged: true });
    expect(ports.native.getSnapshot()).toMatchObject({ text: 'newer B', revision: R2, localIds: [L2] });
  });

  it.each([401, 403, 409, 422])('[H03] a rejected explicit retry %s retains the same frozen request and never falls back to text', async status => {
    const original = intent(); ports.native.publish(snapshot({ pending: original }));
    actionHTTP.mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response({ error: 'Fixture rejection' }, status)); const hook = mount();
    await act(async () => { await hook.result.current.retryPendingMessage?.().catch(() => {}); });
    expect(actionHTTP).toHaveBeenCalledTimes(2); expect(actionHTTP.mock.calls[1][1].body).toBe(original.serializedBody);
    expect(ports.native.getSnapshot().pending).toBe(original); expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.beginUpload).not.toHaveBeenCalled();
    expect(actionHTTP.mock.calls.some(([url]) => url.endsWith('/input'))).toBe(false);
  });

  it('[H03 missing] Check remains possible, but absent pinned bytes blocks Retry POST after 404', async () => {
    const original = intent({ missingBytePins: [{ localId: L1, attachment: A }] }); ports.native.publish(snapshot({ pending: original }));
    ports.native.getBlob.mockRejectedValue(Object.assign(new Error('Missing original bytes'), { code: 'missing_bytes' }));
    actionHTTP.mockResolvedValue(response(null, 404)); const hook = mount();
    await act(async () => { await hook.result.current.retryPendingMessage?.().catch(() => {}); });
    expect(actionHTTP).toHaveBeenCalledTimes(1); expect(ports.native.getBlob).toHaveBeenCalledWith(L1);
    expect(ports.native.getSnapshot().pending).toBe(original); expect(ports.native.prepareIntent).not.toHaveBeenCalled();
  });

  it.each(['account', 'environment'])('[H04] %s ABA during a held receipt read prevents old adoption or a POST', async kind => {
    const original = intent(), held = deferred(); ports.native.publish(snapshot({ pending: original })); actionHTTP.mockReturnValueOnce(held.promise);
    const hook = mount(); let checking;
    await act(async () => { checking = hook.result.current.checkPendingMessage?.(); await Promise.resolve(); });
    expect(actionHTTP).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (kind === 'environment') { setActiveEnvironment({ id: 'paired-fixture', capabilities: { agentExecute: true } }); setActiveEnvironment(null); }
      else { setEnvironmentIdentity('other-owner', window.location.origin); setTokens('fixture-other', 'fixture-refresh'); setUser({ id: 'other-owner' });
        setEnvironmentIdentity('join-fixture-owner', window.location.origin); setTokens('fixture-again', 'fixture-refresh'); setUser({ id: 'join-fixture-owner' }); }
    });
    await act(async () => { held.resolve(response(accepted(original))); await checking; });
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(hook.result.current.messages).toEqual([]);
    expect(actionHTTP).toHaveBeenCalledTimes(1);
  });

  it('[H05] saved image pending stays local-held on mount/reconnect/online/remount with a newer image-free draft', async () => {
    const original = intent(); ports.native.publish(snapshot({ pending: original, text: 'newer image-free B', revision: R2, localIds: [], items: [] }));
    actionHTTP.mockResolvedValue(response(null, 404)); const first = mount(true);
    await act(async () => { Socket.instances.at(-1).onopen?.(); window.dispatchEvent(new Event('online')); });
    first.unmount(); const second = mount(true);
    await act(async () => { Socket.instances.at(-1).onopen?.(); window.dispatchEvent(new Event('online')); });
    expect(actionHTTP).not.toHaveBeenCalled(); expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(ports.native.confirmIntent).not.toHaveBeenCalled();
    await callAction(second, 'checkPendingMessage');
    expect(actionHTTP).toHaveBeenCalledTimes(1); expect(actionHTTP.mock.calls[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/requests/${original.requestId}`);
    expect(ports.native.getSnapshot().pending).toBe(original);
  });
});
