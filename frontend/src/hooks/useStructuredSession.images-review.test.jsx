import { Component } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
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
vi.mock('../utils/userImageDraftStore', async importOriginal => ({ ...await importOriginal(), createUserImageDraftStore: options => scriptedImageStore(options) }));
const bodyValue = options => typeof options.body === 'string' ? JSON.parse(options.body) : options.body;

const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const originalSocket = globalThis.WebSocket;
class Socket {
  static instances = [];
  constructor(url) { this.url = url; Socket.instances.push(this); }
  close() { this.onclose?.({ code: 1000 }); }
}
const emit = event => Socket.instances.at(-1).onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
const imageReceipt = body => ({ status: 'accepted', requestId: body.requestId, turnId: 'image-review-turn', messageId: 'image-review-message', acceptedSeq: 1,
  input: { text: body.text, attachments: body.attachments } });

beforeEach(() => {
  clearTokens(true); localStorage.clear(); setAuthInitializing(false);
  setEnvironmentIdentity('image-hook-review-owner', window.location.origin); setActiveEnvironment(null);
  // Unsigned, five-minute fixture JWT: only the real expiry decoder consumes it.
  // The socket and apiFetch are mocked; no authentication request or key is used.
  const access = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: 'image-hook-review-owner', exp: Math.floor(Date.now() / 1000) + 300 }))}.synthetic-fixture-signature`;
  setTokens(access, 'synthetic-refresh'); setUser({ id: 'image-hook-review-owner' });
  apiFetch.mockReset(); resetImagePorts(); Socket.instances = []; globalThis.WebSocket = Socket;
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  resetImagePorts(); vi.restoreAllMocks(); globalThis.WebSocket = originalSocket;
  setActiveEnvironment(null); setEnvironmentIdentity(null); clearTokens(true); localStorage.clear();
});

describe('real owned image hook malformed events and durable preparation', () => {
  it.each([
    ['invalid descriptor after a valid descriptor', [A, { ...A, bytes: -1 }]],
    ['non-array attachment metadata', { ...A }],
  ])('rejects %s before React adoption without clearing its pending intent', async (_label, attachments) => {
    const sessionId = 'ss-image-malformed-event-review';
    const store = getComposerDraftStore(sessionId);
    store.setText('Keep the raw image draft');
    const pending = await store.prepareIntent('Keep the raw image draft', [A]);
    const before = structuredClone(store.getSnapshot().pending);
    const renderErrors = [], diagnostics = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { diagnostics.push(args); });
    class Boundary extends Component {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { renderErrors.push(error.message); }
      render() { return this.state.failed ? null : this.props.children; }
    }
    const hook = renderHook(() => useStructuredSession({ sessionId, runtime: 'v4', active: true }), {
      wrapper: ({ children }) => <Boundary>{children}</Boundary>,
    });
    await act(async () => { await Promise.resolve(); });
    expect(Socket.instances).toHaveLength(1);
    await act(async () => {
      emit({ type: 'user_message_accepted', seq: 1, ts: 10, requestId: pending.requestId,
        turnId: 'malformed-event-turn', messageId: 'malformed-event-message', content: pending.text, attachments });
    });
    expect(renderErrors).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.actionError).toMatch(/image|metadata|manifest|reconnect/i);
    expect(store.getSnapshot().pending).toEqual(before);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('retains exact valid canonical image metadata without a text-only partial message', async () => {
    const sessionId = 'ss-image-valid-event-review';
    const store = getComposerDraftStore(sessionId);
    store.setText('Canonical image event');
    const pending = await store.prepareIntent('Canonical image event', [A]);
    const hook = renderHook(() => useStructuredSession({ sessionId, runtime: 'v4', active: true }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { emit({ type: 'user_message_accepted', seq: 1, requestId: pending.requestId,
      turnId: 'valid-event-turn', messageId: 'valid-event-message', content: pending.text, attachments: [A] }); });
    expect(hook.result.current.messages).toEqual([expect.objectContaining({ role: 'user', content: pending.text, attachments: [A], requestId: pending.requestId })]);
    expect(hook.result.current.actionError).toBe('');
    expect(store.getSnapshot().pending.requestId).toBe(pending.requestId);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not POST until an asynchronous preparation boundary commits the real image metadata', async () => {
    const sessionId = 'ss-image-async-prepare-review', text = 'Commit before sending';
    const actionHTTP = installImageTransport(apiFetch);
    const store = getComposerDraftStore(sessionId);
    store.setText(text);
    await readyImagePort({ sessionId, raw: text, canonical: text, attachments: [A] });
    const realPrepare = store.prepareIntent.bind(store);
    let commit;
    const gate = new Promise(resolve => { commit = resolve; });
    const prepare = vi.spyOn(store, 'prepareIntent').mockImplementation((...args) => gate.then(() => realPrepare(...args)));
    let committedAtPost;
    actionHTTP.mockImplementation(async (_url, options) => {
      committedAtPost = structuredClone(store.getSnapshot().pending);
      return { ok: true, json: async () => imageReceipt(bodyValue(options)) };
    });
    const hook = renderHook(() => useStructuredSession({ sessionId, runtime: 'v4', active: false, aiType: 'openai', model: 'gpt-5.4' }));
    let sending;
    await act(async () => { sending = hook.result.current.sendMessage(text, [A]); await Promise.resolve(); });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().pending).toBeNull();
    expect(actionHTTP).not.toHaveBeenCalled();
    let result;
    await act(async () => { commit(); result = await sending; });
    const [url, options] = actionHTTP.mock.calls[0];
    expect(url).toBe(`/api/structured/sessions/${sessionId}/attachments/send`);
    expect(committedAtPost).toMatchObject({ requestId: bodyValue(options).requestId, text, attachments: [A] });
    expect(result).toMatchObject({ accepted: true, requestId: bodyValue(options).requestId });
    expect(actionHTTP).toHaveBeenCalledTimes(1);
  });
});
