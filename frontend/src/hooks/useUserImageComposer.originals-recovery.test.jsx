// PREPARE ONLY. Real view hook/controller, controlled native and HTTP ports.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, CATALOG, SESSION, A, B, accepted, response, Socket } from '../test/userImagesJoinFixture';
import { seedPrevious, previous, originalFile, installSuccessfulRestore, noMutationSpies, NEWER_TEXT, NEWER_LOCAL } from '../test/userImagesOriginalsRecoveryFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';
import { useUserImageComposer } from './useUserImageComposer';
import { useStructuredSession } from './useStructuredSession';

let options;
const oldSocket = globalThis.WebSocket;
const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
beforeEach(() => {
  resetFixture(); const { store } = seedPrevious(); globalThis.WebSocket = Socket; Socket.instances = [];
  options = { session: SESSION, active: true, store, sendMessage: vi.fn(), checkPendingMessage: vi.fn(), retryPendingMessage: vi.fn() };
  let urlCounter = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:originals-newer-preview-${++urlCounter}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(null, 404));
});
afterEach(async () => {
  await cleanFixture(); globalThis.WebSocket = oldSocket;
  if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate); else delete URL.createObjectURL;
  if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke); else delete URL.revokeObjectURL;
});
const metadata = view => view.pendingPreviousSend;
const slotArgs = (view, slot) => ({ requestId: metadata(view).requestId, originalsRevision: metadata(view).originalsRevision, ...(slot === undefined ? {} : { slot }) });
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
async function ready(hook) {
  await waitFor(() => expect(hook.result.current.userImages?.pendingPreviousSend?.originals).toHaveLength(3));
  expect(typeof hook.result.current.userImages.selectOriginalImage).toBe('function'); expect(typeof hook.result.current.userImages.saveOriginalImages).toBe('function');
  return hook.result.current.userImages;
}
async function chooseAll(hook) {
  const view = hook.result.current.userImages, files = [originalFile(B), originalFile(A), originalFile(A)];
  await act(async () => { for (let slot = 0; slot < files.length; slot += 1) await view.selectOriginalImage(files[slot], slotArgs(view, slot)); });
  return { view, files };
}
const attachmentHTTP = () => apiFetch.mock.calls.filter(([url]) => url !== '/api/agent/catalog');

describe('shared original choices with per-view authority', () => {
  it('[OH01] duplicate views share choices but do not share an action callback or close owner on first unmount', async () => {
    const first = renderHook(() => useUserImageComposer(options)), second = renderHook(() => useUserImageComposer(options));
    const a = await ready(first); await ready(second);
    await act(async () => { await a.selectOriginalImage(originalFile(B), slotArgs(a, 0)); });
    await waitFor(() => expect(metadata(second.result.current.userImages).originals[0].selected).toBe(true));
    first.unmount();
    await act(async () => { await outcome(a.selectOriginalImage(originalFile(A), slotArgs(a, 1))); });
    expect(metadata(second.result.current.userImages).originals[1].selected).toBe(false); expect(ports.native.close).not.toHaveBeenCalled();
    expect(attachmentHTTP()).toEqual([]); expect(ports.native.restorePendingBytes).not.toHaveBeenCalled();
  });

  it.each(['session', 'account', 'environment', 'inactive', 'readOnly'])('[OH02] %s ABA cannot revive old choose or Save closures', async kind => {
    const hook = renderHook(props => useUserImageComposer(props), { initialProps: options }), old = await ready(hook);
    await chooseAll(hook); const oldChoose = old.selectOriginalImage, oldSave = old.saveOriginalImages, captured = slotArgs(old);
    await act(async () => {
      if (kind === 'account') { setUser({ id: 'other-recovery-owner' }); }
      if (kind === 'environment') { setActiveEnvironment({ id: 'other-recovery-helper' }); }
    });
    if (kind === 'session') hook.rerender({ ...options, session: { ...SESSION, id: 'ss-other-recovery' }, store: getComposerDraftStore('ss-other-recovery') });
    if (kind === 'inactive') hook.rerender({ ...options, active: false });
    if (kind === 'readOnly') hook.rerender({ ...options, readOnly: true });
    await act(async () => {
      if (kind === 'account') setUser({ id: 'join-fixture-owner' });
      if (kind === 'environment') setActiveEnvironment(null);
    });
    const currentStore = kind === 'account' || kind === 'environment' ? getComposerDraftStore(SESSION.id) : options.store;
    hook.rerender({ ...options, store: currentStore }); await ready(hook);
    let staleChoose, staleSave;
    await act(async () => {
      staleChoose = await outcome(oldChoose(originalFile(B), { ...captured, slot: 0 })); staleSave = await outcome(oldSave(captured));
    });
    expect(staleChoose.error).toBeTruthy(); expect(staleSave.error).toBeTruthy();
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); expect(attachmentHTTP()).toEqual([]);
    expect(ports.native.getPendingIntent().requestId).toBe(captured.requestId);
  });

  it('[OH03] read-only transition immediately fences choose and Save even when this view already selected every File', async () => {
    const hook = renderHook(props => useUserImageComposer(props), { initialProps: options }); await ready(hook);
    const { view } = await chooseAll(hook); hook.rerender({ ...options, readOnly: true });
    let staleChoose, staleSave;
    await act(async () => { staleChoose = await outcome(view.selectOriginalImage(originalFile(B), slotArgs(view, 0))); staleSave = await outcome(view.saveOriginalImages(slotArgs(view))); });
    expect(staleChoose.error).toBeTruthy(); expect(staleSave.error).toBeTruthy();
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); expect(attachmentHTTP()).toEqual([]);
  });

  it('[OH04] final unmount/remount loses only unsaved choices and performs no automatic restore, lookup, send or cancel', async () => {
    const first = renderHook(() => useUserImageComposer(options)); await ready(first); await chooseAll(first);
    const before = ports.native.getSnapshot(); first.unmount();
    const second = renderHook(() => useUserImageComposer(options)); await ready(second);
    expect(metadata(second.result.current.userImages).originals.every(slot => !slot.selected)).toBe(true);
    expect(ports.native.getSnapshot()).toBe(before); expect(ports.native.restorePendingBytes).not.toHaveBeenCalled();
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.beginUpload).not.toHaveBeenCalled(); expect(attachmentHTTP()).toEqual([]);
  });

  it.each(['text-only', 'unknown-capability'])('[OH05] real view hook with blocked model %s still allows local original choice and committed Save', async model => {
    const unexpected = [];
    apiFetch.mockImplementation(async (url, request = {}) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        unexpected.push({ url, invalidOptions: true }); throw new Error('Invalid options in local-only model recovery fixture');
      }
      if (url === '/api/agent/catalog' && (!request.method || request.method === 'GET') && request.body === undefined
        && Object.keys(request).every(key => ['method', 'signal'].includes(key)) && request.signal?.aborted === false
        && typeof request.signal.addEventListener === 'function') return response(CATALOG);
      unexpected.push({ url, method: request.method }); throw new Error('Unexpected HTTP in local-only model recovery fixture');
    });
    const hook = renderHook(() => useUserImageComposer({ ...options, session: { ...SESSION, model } })); await ready(hook);
    await waitFor(() => expect(hook.result.current.userImages.admission.state).toBe('blocked'));
    const current = hook.result.current.userImages;
    expect(current.canAdd).toBe(false); expect(current.canSend).toBe(false); expect(metadata(current).originalsCanChoose).toBe(true);
    const beforeHTTP = apiFetch.mock.calls.slice(), original = ports.native.getPendingIntent();
    const { view, files } = await chooseAll(hook);
    expect(metadata(hook.result.current.userImages).originalsCanSave).toBe(true); installSuccessfulRestore(original);
    await act(async () => { expect(await view.saveOriginalImages(slotArgs(view))).toMatchObject({ committed: true }); });
    expect(ports.native.restorePendingBytes).toHaveBeenCalledExactlyOnceWith({ requestId: original.requestId, files });
    expect(apiFetch.mock.calls).toEqual(beforeHTTP); expect(unexpected).toEqual([]);
    for (const spy of noMutationSpies(ports.native)) expect(spy).not.toHaveBeenCalled();
    expect(ports.native.getSnapshot().text).toBe(NEWER_TEXT); expect(ports.native.getSnapshot().localIds).toEqual([NEWER_LOCAL]);
  });
});

describe('restoration does not dispatch an unresolved request', () => {
  function useJoined() {
    const structured = useStructuredSession({ sessionId: SESSION.id, runtime: 'v4', aiType: SESSION.aiType, model: SESSION.model, active: false });
    const composer = useUserImageComposer({ ...options, sendMessage: structured.sendMessage,
      checkPendingMessage: structured.checkPendingMessage, retryPendingMessage: structured.retryPendingMessage });
    return { ...composer, structured };
  }

  it('[OS01] committed Save is local only; a later explicit Retry is GET-first and reuses the original serialized request', async () => {
    const original = ports.native.getPendingIntent(), hook = renderHook(useJoined); await ready(hook);
    const beforeHTTP = apiFetch.mock.calls.slice();
    const { view, files } = await chooseAll(hook); installSuccessfulRestore(original);
    await act(async () => { expect(await view.saveOriginalImages(slotArgs(view))).toMatchObject({ committed: true }); });
    expect(ports.native.restorePendingBytes).toHaveBeenCalledExactlyOnceWith({ requestId: original.requestId, files });
    for (const spy of noMutationSpies(ports.native)) expect(spy).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls).toEqual(beforeHTTP);
    expect(attachmentHTTP()).toEqual([]); expect(ports.native.beginUpload).not.toHaveBeenCalled(); expect(ports.native.confirmIntent).not.toHaveBeenCalled();
    const unexpected = [];
    apiFetch.mockImplementation(async (url, request = {}) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        unexpected.push({ url, invalidOptions: true }); throw new Error('Invalid options in explicit original retry fixture');
      }
      const liveSignal = request.signal?.aborted === false && typeof request.signal.addEventListener === 'function';
      const getOnly = (!request.method || request.method === 'GET') && request.body === undefined
        && Object.keys(request).every(key => ['method', 'signal'].includes(key)) && liveSignal;
      if (url === '/api/agent/catalog' && getOnly) return response(CATALOG);
      if (url === `/api/structured/sessions/${SESSION.id}/requests/${original.requestId}` && getOnly) return response(null, 404);
      if (url === `/api/structured/sessions/${SESSION.id}/attachments/send` && request.method === 'POST' && liveSignal
        && Object.keys(request).sort().join(',') === 'body,headers,method,signal'
        && Object.keys(request.headers || {}).join(',') === 'Content-Type' && request.headers['Content-Type'] === 'application/json'
        && request.body === original.serializedBody) return response(accepted(original));
      unexpected.push({ url, method: request.method }); throw new Error('Unexpected URL or options in explicit original retry fixture');
    });
    await act(async () => { await hook.result.current.userImages.retryPreviousSend(); });
    const calls = attachmentHTTP(); expect(calls).toHaveLength(2);
    expect(unexpected).toEqual([]);
    expect(calls[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/requests/${original.requestId}`);
    expect(calls[0][1]?.method || 'GET').toBe('GET');
    expect(calls[1][0]).toBe(`/api/structured/sessions/${SESSION.id}/attachments/send`);
    expect(calls[1][1]).toMatchObject({ method: 'POST', body: original.serializedBody });
    expect(ports.native.getBlob.mock.calls.map(([localId]) => localId).filter(localId => original.submittedLocalIds.includes(localId))).toEqual(original.submittedLocalIds);
    expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(ports.native.getSnapshot().text).toBe(NEWER_TEXT);
    expect(ports.native.getSnapshot().localIds).toEqual([NEWER_LOCAL]);
  });

  it('[OS02] stored accepted proof never auto-settles; explicit Check alone may retry strict local cleanup while a native failure stays held', async () => {
    const base = previous(), proof = accepted(base), pending = previous({ acceptedReceipt: proof });
    seedPrevious(pending); ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error('Native phase2 quota'), { code: 'quota' }));
    apiFetch.mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(proof));
    const hook = renderHook(useJoined); await ready(hook);
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(attachmentHTTP()).toEqual([]);
    await act(async () => { await hook.result.current.userImages.checkPreviousSend(); });
    expect(ports.native.confirmIntent).toHaveBeenCalledExactlyOnceWith({ requestId: pending.requestId, receipt: proof });
    expect(attachmentHTTP().length).toBeLessThanOrEqual(1);
    expect(attachmentHTTP().every(([url, options]) => url.endsWith(`/requests/${pending.requestId}`) && (!options?.method || options.method === 'GET'))).toBe(true);
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); expect(ports.native.prepareIntent).not.toHaveBeenCalled();
    expect(ports.native.getPendingIntent()).toBe(pending); expect(ports.native.getSnapshot().text).toBe(NEWER_TEXT);
    await act(async () => { await Promise.resolve(); }); expect(ports.native.confirmIntent).toHaveBeenCalledTimes(1);
    await act(async () => { await hook.result.current.userImages.checkPreviousSend(); });
    expect(ports.native.confirmIntent).toHaveBeenCalledTimes(2); expect(ports.native.confirmIntent.mock.calls[1][0]).toEqual({ requestId: pending.requestId, receipt: proof });
    expect(attachmentHTTP().every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('[OS03] a mismatched GET receipt cannot confirm the old frozen request or fall through to POST', async () => {
    const original = ports.native.getPendingIntent(), before = ports.native.getSnapshot();
    const hook = renderHook(useJoined); await ready(hook);
    apiFetch.mockResolvedValue(response(accepted({ ...original, attachments: [B, A, A] })));
    await act(async () => { await outcome(hook.result.current.userImages.checkPreviousSend()); });
    expect(attachmentHTTP()).toHaveLength(1); expect(attachmentHTTP()[0][1]?.method || 'GET').toBe('GET');
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.restorePendingBytes).not.toHaveBeenCalled();
    expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(ports.native.getSnapshot()).toBe(before);
    expect(ports.native.getPendingIntent().serializedBody).toBe(original.serializedBody);
  });
});
