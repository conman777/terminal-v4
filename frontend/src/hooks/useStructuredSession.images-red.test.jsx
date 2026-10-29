// SCRATCH TEST PREVIEW ONLY. Proposed sendMessage(text, attachments) seam.
// apiFetch is mocked: this cannot prove upload, IndexedDB, HTTP, or actual App.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { clearTokens, setAuthInitializing, setTokens, setUser } from '../utils/auth';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { readyImagePort, resetImagePorts, scriptedImageStore } from '../test/imageHookNativePort';
import { installImageTransport } from '../test/imageHookTransport';
let actionHTTP;
vi.mock('../utils/userImageDraftStore', async importOriginal => ({ ...await importOriginal(), createUserImageDraftStore: options => scriptedImageStore(options) }));

const A = Object.freeze({ attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' });
const B = Object.freeze({ attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/png', bytes: 68, name: 'second.png' });
const mount = (sessionId = 'ss-image-red-fixture') => renderHook(() => useStructuredSession({ sessionId, runtime: 'v4', active: false, aiType: 'openai', model: 'gpt-5.4' }));
const bodyValue = options => typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
const receipt = (requestId, text, attachments) => ({ status: 'completed', requestId, turnId: 'fixture-turn', messageId: 'fixture-message', acceptedSeq: 1, input: { text, attachments } });
const missing = () => ({ ok: false, status: 404 });

describe('owned user image send identity RED proposal', () => {
  beforeEach(() => {
    clearTokens(true); localStorage.clear(); setAuthInitializing(false);
    setEnvironmentIdentity('image-red-owner', window.location.origin); setActiveEnvironment(null);
    setTokens('synthetic-access', 'synthetic-refresh'); setUser({ id: 'image-red-owner' });
    apiFetch.mockReset(); actionHTTP = installImageTransport(apiFetch); resetImagePorts();
  });
  afterEach(async () => {
    await act(async () => { cleanup(); });
    resetImagePorts(); vi.restoreAllMocks();
    setActiveEnvironment(null); setEnvironmentIdentity(null); clearTokens(true); localStorage.clear();
  });

  function loseSends(bodies) {
    actionHTTP.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { bodies.push(structuredClone(bodyValue(options))); throw new TypeError('Synthetic lost receipt'); }
      return missing();
    });
  }

  it('treats a ready image-only draft as sendable and carries typed refs rather than a filesystem path', async () => {
    actionHTTP.mockImplementation(async (_url, options) => {
      const body = bodyValue(options);
      return { ok: true, json: async () => receipt(body.requestId, '', [A]) };
    });
    await readyImagePort({ sessionId: 'ss-image-red-fixture', raw: '', canonical: '', attachments: [A] });
    const hook = mount(); let result;
    await act(async () => { result = await hook.result.current.sendMessage('', [A]); });
    expect(result).toMatchObject({ accepted: true });
    const [url, options] = actionHTTP.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(url).toBe('/api/structured/sessions/ss-image-red-fixture/attachments/send');
    expect(bodyValue(options).attachments).toEqual([A]);
    expect(JSON.stringify(bodyValue(options))).not.toMatch(/file:\/\/|\/synthetic\/path/);
  });

  it('freezes ordered descriptors and the same UUID across an uncertain send and hook remount', async () => {
    const bodies = []; loseSends(bodies);
    await readyImagePort({ sessionId: 'ss-image-red-fixture', raw: 'Keep exact image request', canonical: 'Keep exact image request', attachments: [A, B] });
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Keep exact image request', [A, B])).rejects.toThrow(); });
    expect(bodies[0].attachments).toEqual([A, B]);
    first.unmount();
    const second = mount();
    await act(async () => { await expect(second.result.current.retryPendingMessage()).rejects.toThrow(); });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('never adopts a persisted receipt for the same UUID with another attachment manifest', async () => {
    const bodies = []; loseSends(bodies);
    await readyImagePort({ sessionId: 'ss-image-red-fixture', raw: 'Receipt association', canonical: 'Receipt association', attachments: [A] });
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Receipt association', [A])).rejects.toThrow(); });
    first.unmount(); actionHTTP.mockClear();
    actionHTTP.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new Error('Mismatched receipt must not cause a new POST');
      return { ok: true, json: async () => receipt(bodies[0].requestId, 'Receipt association', [B]) };
    });
    const second = mount();
    await act(async () => { await expect(second.result.current.retryPendingMessage()).rejects.toThrow(/receipt|manifest|confirm/i); });
    expect(actionHTTP.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('does not overwrite an unresolved pending send when the current draft changes its image', async () => {
    const bodies = []; loseSends(bodies);
    await readyImagePort({ sessionId: 'ss-image-red-fixture', raw: 'Pending exact body', canonical: 'Pending exact body', attachments: [A] });
    const hook = mount();
    await act(async () => { await expect(hook.result.current.sendMessage('Pending exact body', [A])).rejects.toThrow(); });
    await act(async () => { await expect(hook.result.current.sendMessage('Pending exact body', [B])).rejects.toThrow(); });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].attachments).toEqual([A]);
    // New B remains a separate draft. This test intentionally does not claim
    // Blob durability or the UI state for B; the real browser gate covers it.
  });

  it('snapshots caller descriptors before later mutation can change the in-flight body', async () => {
    let release;
    const pendingResponse = new Promise(resolve => { release = resolve; });
    actionHTTP.mockReturnValueOnce(pendingResponse);
    const refs = [{ ...A }];
    await readyImagePort({ sessionId: 'ss-image-red-fixture', raw: 'Frozen caller input', canonical: 'Frozen caller input', attachments: [A] });
    const hook = mount(); let pending;
    act(() => { pending = hook.result.current.sendMessage('Frozen caller input', refs); });
    await waitFor(() => expect(actionHTTP.mock.calls.some(([, value]) => value?.method === 'POST')).toBe(true));
    const options = actionHTTP.mock.calls.find(([, value]) => value?.method === 'POST')[1];
    const original = structuredClone(bodyValue(options));
    refs[0].name = 'mutated-after-submit.png'; refs.push({ ...B });
    expect(bodyValue(options)).toEqual(original);
    expect(original.attachments).toEqual([A]);
    await act(async () => { release({ ok: true, json: async () => receipt(original.requestId, 'Frozen caller input', [A]) }); await pending; });
  });

  it('keeps this first image slice local-only even when a selected paired environment permits agent execution', async () => {
    setActiveEnvironment({ id: 'paired-fixture', capabilities: { agentExecute: true, transfer: true, fileWrite: true } });
    actionHTTP.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(bodyValue(options).requestId, 'Local-only image', [A]) }));
    const hook = mount(); let outcome;
    await act(async () => { outcome = await hook.result.current.sendMessage('Local-only image', [A]).catch(error => ({ error })); });
    expect(outcome?.accepted).not.toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
      ['CRLF/decomposed accent', ' \tCafe\u0301\r\nsnow \u2603\u00a0\n', 'Cafe\u0301\nsnow \u2603'],
      ['NEL boundaries', '\u0085Cafe\u0301\r\nsnow \u2603\u0085', 'Cafe\u0301\nsnow \u2603'],
      ['BOM boundaries', '\ufeffCafe\u0301\r\nsnow \u2603\ufeff', '\ufeffCafe\u0301\nsnow \u2603\ufeff'],
      ['NEL outside BOM', '\u0085\ufeffCafe\u0301\r\nsnow \u2603\ufeff\u0085', '\ufeffCafe\u0301\nsnow \u2603\ufeff'],
      ['BOM outside NEL', '\ufeff\u0085Cafe\u0301\r\nsnow \u2603\u0085\ufeff', '\ufeff\u0085Cafe\u0301\nsnow \u2603\u0085\ufeff'],
  ])('freezes the %s projection and never changes it during remount retry', async (_label, raw, canonical) => {
    const sessionId = 'ss-image-unicode-red';
    const bodies = []; loseSends(bodies);
    await readyImagePort({ sessionId, raw, canonical, attachments: [A, B] });
    const first = mount(sessionId);
    await act(async () => { await expect(first.result.current.sendMessage(raw, [A, B])).rejects.toThrow(); });
    expect(bodies[0].text).toBe(canonical);
    expect(bodies[0].attachments).toEqual([A, B]);
    first.unmount(); const second = mount(sessionId);
    await act(async () => { await expect(second.result.current.retryPendingMessage()).rejects.toThrow(); });
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
    expect(bodies[1].text).not.toContain('Caf\u00e9');
    second.unmount();
    // Raw draft byte preservation belongs to the real Blob/draft browser gate;
    // this test covers only the frozen transport projection, not its raw source.
  });

  it('publishes the complete durable image intent before the first POST is invoked', async () => {
    const sessionId = 'ss-image-before-post-red';
    const text = 'Persist complete image intent first';
    const store = getComposerDraftStore(sessionId);
    store.setText(text);
    const revision = store.getSnapshot().revision;
    await readyImagePort({ sessionId, raw: text, canonical: text, attachments: [A, B] });
    const realPrepare = store.prepareIntent.bind(store);
    let prepareCompleted = false, committedAtReturn = null, firstPost = null;
    const committed = intent => {
      committedAtReturn = structuredClone(store.getSnapshot().pending);
      prepareCompleted = true;
      return intent;
    };
    const prepare = vi.spyOn(store, 'prepareIntent').mockImplementation((...args) => {
      const result = realPrepare(...args);
      return result && typeof result.then === 'function' ? result.then(committed) : committed(result);
    });
    actionHTTP.mockImplementation((url, options) => {
      if (options?.method !== 'POST') return Promise.resolve(missing());
      const body = structuredClone(bodyValue(options));
      // Capture the real scoped store synchronously when the first POST starts,
      // before any HTTP result or catch-path persistence can occur. prepareIntent
      // is its existing required-durability boundary, not a storage backend API.
      if (!firstPost) firstPost = {
        url, body, prepareCompleted,
        pending: structuredClone(store.getSnapshot().pending),
        committedAtReturn: structuredClone(committedAtReturn),
      };
      return Promise.resolve({ ok: true, json: async () => receipt(body.requestId, text, [A, B]) });
    });
    const hook = mount(sessionId); let result;
    await act(async () => { result = await hook.result.current.sendMessage(text, [A, B]); });
    expect(result).toMatchObject({ accepted: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(firstPost.prepareCompleted).toBe(true);
    expect(firstPost.url).toBe(`/api/structured/sessions/${sessionId}/attachments/send`);
    expect(firstPost.body).toMatchObject({ text, attachments: [A, B] });
    expect(firstPost.pending).toMatchObject({ requestId: firstPost.body.requestId, draftRevision: revision, text, attachments: [A, B] });
    expect(firstPost.committedAtReturn).toEqual(firstPost.pending);
    const storedInput = { requestId: firstPost.pending.requestId, text: firstPost.pending.text, attachments: firstPost.pending.attachments };
    const postedInput = { requestId: firstPost.body.requestId, text: firstPost.body.text, attachments: firstPost.body.attachments };
    expect(JSON.stringify(storedInput)).toBe(JSON.stringify(postedInput));
  });

  it('never POSTs an image send when the scoped durable-intent boundary reports a quota failure', async () => {
    const sessionId = 'ss-image-quota-red';
    const text = 'Keep this image draft on quota failure';
    const store = getComposerDraftStore(sessionId);
    store.setText(text);
    const before = structuredClone(store.getSnapshot());
    await readyImagePort({ sessionId, raw: text, canonical: text, attachments: [A, B] });
    const prepare = vi.spyOn(store, 'prepareIntent').mockImplementationOnce(() => {
      throw new DOMException('Synthetic image-intent persistence quota failure', 'QuotaExceededError');
    });
    actionHTTP.mockImplementation(() => { throw new Error('An unsaved image intent must never reach HTTP'); });
    const hook = mount(sessionId);
    await act(async () => { await expect(hook.result.current.sendMessage(text, [A, B])).rejects.toThrow(/quota|save|persist|storage/i); });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(actionHTTP).not.toHaveBeenCalled();
    expect(store.getSnapshot().text).toBe(before.text);
    expect(store.getSnapshot().revision).toBe(before.revision);
    expect(store.getSnapshot().pending).toEqual(before.pending);
    // Failure is injected at the existing store port. This is not a claim that
    // native IndexedDB quota/transaction or Blob atomicity was exercised.
  });
});
