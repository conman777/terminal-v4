// UNAPPLIED controlled-port tests. Existing real hook/facade, no native reducer.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, nativeBoundary, snapshot, intent, accepted, response, deferred, A, L1, L2, R1, R2, RAW, CANONICAL, SESSION, CATALOG } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { useStructuredSession } from './useStructuredSession';
let original;
beforeEach(() => { resetFixture(); apiFetch.mockReset(); const facade = getComposerDraftStore(SESSION.id); nativeBoundary(facade);
  original = intent(); ports.native.publish(snapshot({ pending: original })); });
afterEach(cleanFixture);
const options = model => ({ sessionId: SESSION.id, runtime: 'v4', active: false, aiType: SESSION.aiType, model });
const posts = () => apiFetch.mock.calls.filter(([, value]) => value?.method === 'POST');
function protocol(url) {
  if (url === '/api/agent/catalog') return response(CATALOG);
  if (url.includes('/requests/')) return response(null, 404);
  return response(accepted(original));
}
async function retry(hook) { let outcome, error; await act(async () => { try { outcome = await hook.result.current.retryPendingMessage(); } catch (problem) { error = problem; } }); return { outcome, error }; }

describe('exact current selected-model authority at image Retry POST', () => {
  it.each(['text-only', 'unknown-capability', 'custom-unconfirmed'])('holds a frozen retry when canonical model %s is not explicitly image-capable', async model => {
    apiFetch.mockImplementation(async url => protocol(url)); const hook = renderHook(() => useStructuredSession(options(model)));
    const result = await retry(hook);
    expect(posts()).toEqual([]); expect(result.outcome?.accepted).not.toBe(true);
    expect(result.error?.message || hook.result.current.actionError).toMatch(/model|image support|admission|capability/i);
    expect(ports.native.getPendingIntent()).toBe(original); expect(ports.native.confirmIntent).not.toHaveBeenCalled();
  });
  it('allows an exact known-model retry without changing its body, UUID or ordinary message receipt', async () => {
    apiFetch.mockImplementation(async url => protocol(url)); const hook = renderHook(() => useStructuredSession(options(SESSION.model)));
    const { outcome } = await retry(hook);
    expect(outcome).toMatchObject({ accepted: true, requestId: original.requestId, draftManaged: true });
    expect(posts()).toHaveLength(1); expect(posts()[0][1].body).toBe(original.serializedBody);
    expect(ports.native.getBlob).toHaveBeenCalledWith(L1);
    expect(apiFetch.mock.calls.some(([url]) => url === '/api/agent/catalog')).toBe(true);
  });
  it('does not POST after model ABA while the original receipt lookup is held', async () => {
    const held = deferred(); apiFetch.mockImplementation(url => url.includes('/requests/') ? held.promise : Promise.resolve(protocol(url)));
    const hook = renderHook(({ model }) => useStructuredSession(options(model)), { initialProps: { model: SESSION.model } });
    let action; await act(async () => { action = hook.result.current.retryPendingMessage(); action.catch(() => {}); });
    await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.includes('/requests/'))).toBe(true));
    hook.rerender({ model: 'text-only' }); hook.rerender({ model: SESSION.model });
    await act(async () => { held.resolve(response(null, 404)); await action.catch(() => {}); });
    expect(posts()).toEqual([]); expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.getPendingIntent()).toBe(original);
  });
  it('rechecks selection after an awaited pinned-byte read changes from allowed to blocked', async () => {
    const held = deferred(), blob = await ports.native.getBlob(L1); ports.native.getBlob.mockClear().mockReturnValueOnce(held.promise);
    apiFetch.mockImplementation(async url => protocol(url));
    const hook = renderHook(({ model }) => useStructuredSession(options(model)), { initialProps: { model: SESSION.model } });
    let action; await act(async () => { action = hook.result.current.retryPendingMessage(); action.catch(() => {}); });
    await waitFor(() => expect(ports.native.getBlob).toHaveBeenCalledWith(L1)); hook.rerender({ model: 'text-only' });
    await act(async () => { held.resolve(blob); await action.catch(() => {}); });
    expect(posts()).toEqual([]); expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.getPendingIntent()).toBe(original);
  });
  it.each(['text-only', 'unknown-capability', 'custom-unconfirmed'])('rejects new image Send for unconfirmed canonical model %s before prepare or POST', async model => {
    ports.native.publish(snapshot()); apiFetch.mockImplementation(async url => protocol(url));
    const hook = renderHook(() => useStructuredSession(options(model))); let outcome;
    await act(async () => { outcome = await hook.result.current.sendMessage(RAW, [A]).catch(error => ({ error })); });
    expect(outcome?.accepted).not.toBe(true); expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(posts()).toEqual([]);
    expect(ports.native.getSnapshot()).toMatchObject({ text: RAW, revision: R1, localIds: [L1], pending: null });
  });
  it('captures raw projection/revision/IDs/refs before the first catalog await without rebasing to newer B', async () => {
    const held = deferred(), refs = [{ ...A }]; ports.native.publish(snapshot());
    ports.native.prepareIntent.mockRejectedValueOnce(Object.assign(new Error('Synthetic changed source conflict'), { code: 'conflict' }));
    apiFetch.mockImplementation(url => url === '/api/agent/catalog' ? held.promise : Promise.resolve(protocol(url)));
    const hook = renderHook(() => useStructuredSession(options(SESSION.model))); let sending;
    await act(async () => { sending = hook.result.current.sendMessage(RAW, refs); sending.catch(() => {}); });
    await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url === '/api/agent/catalog')).toBe(true));
    expect(ports.native.prepareIntent).not.toHaveBeenCalled();
    refs[0].name = 'later-caller-mutation.png';
    ports.native.publish(snapshot({ text: 'New raw B', revision: R2, committedRevision: R2, localIds: [L2], items: [] }));
    await act(async () => { held.resolve(response(CATALOG)); await sending.catch(() => {}); });
    expect(ports.native.prepareIntent).toHaveBeenCalledWith({ text: CANONICAL, attachments: [A], draftRevision: R1, localIds: [L1] });
    expect(posts()).toEqual([]); expect(ports.native.getSnapshot()).toMatchObject({ text: 'New raw B', revision: R2, localIds: [L2] });
  });
  it('fences a GET-only Check when its originating model selection changes through ABA', async () => {
    const held = deferred(); apiFetch.mockReturnValueOnce(held.promise);
    const hook = renderHook(({ model }) => useStructuredSession(options(model)), { initialProps: { model: SESSION.model } });
    let checking; await act(async () => { checking = hook.result.current.checkPendingMessage(); checking.catch(() => {}); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1)); hook.rerender({ model: 'text-only' }); hook.rerender({ model: SESSION.model });
    await act(async () => { held.resolve(response(accepted(original))); await checking.catch(() => {}); });
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(hook.result.current.messages).toEqual([]);
    expect(posts()).toEqual([]); expect(ports.native.getPendingIntent()).toBe(original);
  });
  it('still permits GET-only accepted proof cleanup under an unknown current model with missing pins', async () => {
    original = intent({ missingBytePins: [{ localId: L1, attachment: A }] }); ports.native.publish(snapshot({ pending: original }));
    apiFetch.mockResolvedValue(response(accepted(original))); const hook = renderHook(() => useStructuredSession(options('custom-unconfirmed')));
    let outcome; await act(async () => { outcome = await hook.result.current.checkPendingMessage(); });
    expect(outcome).toMatchObject({ accepted: true, draftManaged: true }); expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toContain('/requests/'); expect(posts()).toEqual([]); expect(ports.native.getBlob).not.toHaveBeenCalled();
  });
});

describe('native accepted-proof contradictions never become accepted user rows', () => {
  it.each(['turnId', 'messageId', 'acceptedSeq'])('rejects a lookup contradicting durable %s without merging or clearing', async field => {
    const proof = accepted(original); original = intent({ acceptedReceipt: proof }); ports.native.publish(snapshot({ pending: original }));
    const contradictory = { ...proof, [field]: field === 'acceptedSeq' ? proof.acceptedSeq + 1 : `different-${field}` };
    apiFetch.mockResolvedValue(response(contradictory));
    ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error('Receipt contradicts durable identity'), { code: 'receipt_mismatch' }));
    const hook = renderHook(() => useStructuredSession(options(SESSION.model))); const result = await retry(hook);
    expect(result.outcome?.accepted).not.toBe(true); expect(result.error?.message || hook.result.current.actionError).toMatch(/receipt|identity|contradict/i);
    expect(hook.result.current.messages).toEqual([]); expect(ports.native.getPendingIntent()).toBe(original);
    expect(ports.native.getPendingIntent().acceptedReceipt).toEqual(proof); expect(posts()).toEqual([]);
  });
  it('rejects receipt_mismatch from a confirmation race after a successful HTTP image send', async () => {
    ports.native.publish(snapshot()); ports.native.prepareIntent.mockImplementation(async () => { ports.native.publish(snapshot({ pending: original })); return original; });
    apiFetch.mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(accepted(original)));
    ports.native.confirmIntent.mockRejectedValue(Object.assign(new Error('Receipt identity changed during confirmation'), { code: 'receipt_mismatch' }));
    const hook = renderHook(() => useStructuredSession(options(SESSION.model))); let outcome;
    await act(async () => { outcome = await hook.result.current.sendMessage(snapshot().text, [A]).catch(error => ({ error })); });
    expect(outcome?.accepted).not.toBe(true); expect(outcome.error?.message || hook.result.current.actionError).toMatch(/receipt|identity/i);
    expect(hook.result.current.messages).toEqual([]); expect(ports.native.getPendingIntent()).toBe(original);
    expect(posts()).toHaveLength(1); expect(posts()[0][1].body).toBe(original.serializedBody);
  });
  it.each(['quota', 'unavailable'])('keeps genuine %s local cleanup failures visibly recoverable after exact accepted proof', async code => {
    const proof = accepted(original); original = intent({ acceptedReceipt: proof }); ports.native.publish(snapshot({ pending: original }));
    ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error('Synthetic local cleanup storage failure'), { code }));
    const hook = renderHook(() => useStructuredSession(options('custom-unconfirmed'))); let outcome;
    await act(async () => { outcome = await hook.result.current.checkPendingMessage(); });
    expect(outcome).toMatchObject({ accepted: true, localCleanupPending: true, draftManaged: true });
    expect(ports.native.getPendingIntent()).toBe(original); expect(apiFetch).not.toHaveBeenCalled();
  });
});

// V3 additions only. The original nineteen cases above remain byte-exact.
describe('missing canonical metadata and late Send selection fencing', () => {
  it.each(['aiType', 'model'])('rejects image Send when the canonical %s property is omitted', async missing => {
    const config = options(SESSION.model); delete config[missing];
    expect(Object.hasOwn(config, missing)).toBe(false);
    ports.native.publish(snapshot()); apiFetch.mockImplementation(async url => protocol(url));
    const hook = renderHook(() => useStructuredSession(config)); let outcome;
    await act(async () => { outcome = await hook.result.current.sendMessage(RAW, [A]).catch(error => ({ error })); });
    expect(outcome?.accepted).not.toBe(true); expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(posts()).toEqual([]);
    expect(outcome.error?.message || hook.result.current.actionError).toMatch(/model|provider|metadata|image support|admission|capability/i);
    expect(ports.native.getSnapshot()).toMatchObject({ text: RAW, revision: R1, localIds: [L1], pending: null });
  });

  it('keeps a committed pending Send held after model ABA while native preparation is pending', async () => {
    const held = deferred(); ports.native.publish(snapshot()); ports.native.prepareIntent.mockReturnValueOnce(held.promise);
    apiFetch.mockImplementation(async url => protocol(url));
    const hook = renderHook(({ model }) => useStructuredSession(options(model)), { initialProps: { model: SESSION.model } });
    let sending; await act(async () => { sending = hook.result.current.sendMessage(RAW, [A]); sending.catch(() => {}); });
    await waitFor(() => expect(ports.native.prepareIntent).toHaveBeenCalledTimes(1));
    expect(ports.native.prepareIntent).toHaveBeenCalledWith({ text: CANONICAL, attachments: [A], draftRevision: R1, localIds: [L1] });
    hook.rerender({ model: 'text-only' }); hook.rerender({ model: SESSION.model });
    await act(async () => { ports.native.publish(snapshot({ pending: original })); held.resolve(original); await sending.catch(() => {}); });
    expect(posts()).toEqual([]); expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(hook.result.current.messages).toEqual([]);
    expect(ports.native.getPendingIntent()).toBe(original);
    expect(hook.result.current.isSending).toBe(false);
    expect(ports.native.getSnapshot()).toMatchObject({ text: RAW, revision: R1, localIds: [L1], pending: original });
  });

  it('does not adopt a successful Send receipt after model ABA while POST response JSON is pending', async () => {
    const held = deferred(), readReceipt = vi.fn(() => held.promise); ports.native.publish(snapshot());
    ports.native.prepareIntent.mockImplementation(async () => { ports.native.publish(snapshot({ pending: original })); return original; });
    apiFetch.mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG)
      : url.endsWith('/attachments/send') ? { ok: true, status: 202, json: readReceipt } : response(accepted(original)));
    const hook = renderHook(({ model }) => useStructuredSession(options(model)), { initialProps: { model: SESSION.model } });
    let sending; await act(async () => { sending = hook.result.current.sendMessage(RAW, [A]); sending.catch(() => {}); });
    await waitFor(() => expect(readReceipt).toHaveBeenCalledTimes(1)); expect(posts()).toHaveLength(1);
    hook.rerender({ model: 'text-only' }); hook.rerender({ model: SESSION.model });
    await act(async () => { held.resolve(accepted(original)); await sending.catch(() => {}); });
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(hook.result.current.messages).toEqual([]);
    expect(ports.native.getPendingIntent()).toBe(original); expect(posts()).toHaveLength(1); expect(posts()[0][1].body).toBe(original.serializedBody);
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toEqual([]);
    expect(hook.result.current.isSending).toBe(false);
  });
});

describe('hard local confirmation errors cannot enter HTTP uncertainty recovery', () => {
  it.each(['receipt_mismatch', 'corrupt', 'unrecognized_native_error'])('rejects post-confirm %s once without GET retry or adoption', async code => {
    ports.native.publish(snapshot());
    ports.native.prepareIntent.mockImplementation(async () => { ports.native.publish(snapshot({ pending: original })); return original; });
    // Only the first confirmation rejects. A broad catch→GET→confirm fallback
    // would get a valid receipt and the default successful second confirmation.
    ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error(`Synthetic hard confirmation ${code}`), { code }));
    apiFetch.mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(accepted(original)));
    const hook = renderHook(() => useStructuredSession(options(SESSION.model))); let outcome;
    await act(async () => { outcome = await hook.result.current.sendMessage(RAW, [A]).catch(error => ({ error })); });
    expect(outcome?.accepted).not.toBe(true); expect(outcome?.localCleanupPending).not.toBe(true);
    expect(ports.native.confirmIntent).toHaveBeenCalledTimes(1);
    expect(hook.result.current.messages).toEqual([]); expect(ports.native.getPendingIntent()).toBe(original);
    expect(ports.native.getSnapshot()).toMatchObject({ text: RAW, revision: R1, localIds: [L1], pending: original });
    expect(posts()).toHaveLength(1); expect(posts()[0][1].body).toBe(original.serializedBody);
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toEqual([]);
  });
});

// V4 strict-proof controls. Storage availability cannot authorize a known
// contradiction of an already-held accepted receipt's canonical identity.
describe('existing core receipt proof precedes recoverable storage cleanup', () => {
  it.each(['quota', 'unavailable'])('rejects a known proof mismatch before native %s confirmation can run', async code => {
    const proofA = accepted(original); original = intent({ acceptedReceipt: proofA });
    ports.native.publish(snapshot({ pending: original }));
    const proofB = { ...proofA, messageId: 'contradictory-message-for-same-request-and-input' };
    apiFetch.mockResolvedValue(response(proofB));
    ports.native.confirmIntent.mockRejectedValueOnce(Object.assign(new Error(`Synthetic ${code} before local proof validation`), { code }));
    const hook = renderHook(() => useStructuredSession(options(SESSION.model))); const result = await retry(hook);
    expect(result.outcome?.accepted).not.toBe(true); expect(result.outcome?.localCleanupPending).not.toBe(true);
    expect(result.error?.message || hook.result.current.actionError).toMatch(/receipt|identity|contradict/i);
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(hook.result.current.messages).toEqual([]);
    expect(ports.native.getPendingIntent()).toBe(original); expect(ports.native.getPendingIntent().acceptedReceipt).toEqual(proofA);
    expect(ports.native.getSnapshot()).toMatchObject({ text: RAW, revision: R1, localIds: [L1], pending: original });
    expect(posts()).toEqual([]); expect(apiFetch).toHaveBeenCalledTimes(1); expect(apiFetch.mock.calls[0][0]).toContain('/requests/');
  });
});
