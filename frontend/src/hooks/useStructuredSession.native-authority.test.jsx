import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, SESSION, A, L1, R1, snapshot, intent, accepted, response, Socket } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { useStructuredSession } from './useStructuredSession';
const previousSocket = globalThis.WebSocket;
beforeEach(() => { resetFixture(); apiFetch.mockReset(); Socket.instances = []; globalThis.WebSocket = Socket; });
afterEach(async () => { await cleanFixture(); globalThis.WebSocket = previousSocket; });
const mount = (active = false) => renderHook(() => useStructuredSession({ sessionId: SESSION.id, runtime: 'v4', active }));
function legacyPending() {
  const facade = getComposerDraftStore(SESSION.id); facade.setText('Raw original A');
  const old = facade.prepareIntent('Canonical original A', [A]);
  const imported = intent({ requestId: old.requestId, text: old.text, draftRevision: old.draftRevision,
    attachments: old.attachments, missingBytePins: [{ localId: L1, attachment: A }], rawSourceEvidence: { kind: 'legacy_image_unknown' },
    serializedBody: JSON.stringify({ requestId: old.requestId, text: old.text, attachments: old.attachments }) });
  const ready = snapshot({ text: 'Raw original A', revision: old.draftRevision, committedRevision: old.draftRevision,
    localIds: [], items: [], pending: imported });
  ports.native.publish({ ...ready, storageState: 'legacy', pending: null });
  const hydrated = { ...ready, storageState: 'legacy' };
  // Actual native hydrate imports the v1 pending as locally-held legacy state;
  // ready authority is withheld until explicit promotion finishes.
  ports.native.hydrate.mockImplementation(async () => { ports.native.publish(hydrated); return hydrated; });
  ports.native.promoteLegacy.mockImplementation(async () => { ports.native.publish(ready); return ready; });
  return { facade, old, imported };
}
describe('native authority admission and explicit historical image recovery', () => {
  it.each([false, true])('rejects a direct image send without native authority before prepare/HTTP/DB (old pending=%s)', async withPending => {
    const facade = getComposerDraftStore(SESSION.id); facade.setText('Keep raw text');
    if (withPending) facade.prepareIntent('Previous canonical text', [A]);
    const previous = structuredClone(facade.getSnapshot()), prepare = vi.spyOn(facade, 'prepareIntent');
    const hook = mount();
    await act(async () => { await expect(hook.result.current.sendMessage('Keep raw text', [A])).rejects.toThrow(/saved|device|add/i); });
    expect(prepare).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled(); expect(ports.nativeFactory).not.toHaveBeenCalled();
    expect(facade.getSnapshot()).toEqual(previous); expect(facade.getImageStore()).toBeNull();
  });
  it('mount/remount/online never looks up, promotes or POSTs a historical image pending', async () => {
    const { facade, old } = legacyPending();
    const first = mount(true); await act(async () => { Socket.instances.at(-1).onopen?.(); window.dispatchEvent(new Event('online')); });
    first.unmount(); const second = mount(true);
    await act(async () => { Socket.instances.at(-1).onopen?.(); window.dispatchEvent(new Event('online')); });
    expect(apiFetch).not.toHaveBeenCalled(); expect(ports.nativeFactory).not.toHaveBeenCalled(); expect(ports.native.promoteLegacy).not.toHaveBeenCalled();
    expect(facade.getSnapshot().pending.requestId).toBe(old.requestId); second.unmount();
  });
  it('explicit Check promotes the original v1 identity before GET and accepts exact proof despite missing pins', async () => {
    const { facade, old, imported } = legacyPending(); const prepare = vi.spyOn(facade, 'prepareIntent');
    const complete = snapshot({ text: 'Raw original A', revision: old.draftRevision, localIds: [], items: [], pending: null });
    ports.native.confirmIntent.mockImplementation(async () => { ports.native.publish(complete); return { committed: true, clearedDraft: false, snapshot: complete }; });
    apiFetch.mockImplementation(async (url, options) => {
      expect(ports.native.promoteLegacy).toHaveBeenCalledTimes(1);
      expect(url).toBe(`/api/structured/sessions/${SESSION.id}/requests/${old.requestId}`); expect(options.method).toBeUndefined();
      return response(accepted(imported));
    });
    const hook = mount(); let result;
    await act(async () => { result = await hook.result.current.checkPendingMessage?.(); });
    expect(result).toMatchObject({ accepted: true, draftManaged: true, requestId: old.requestId });
    expect(apiFetch).toHaveBeenCalledTimes(1); expect(prepare).not.toHaveBeenCalled(); expect(ports.native.prepareIntent).not.toHaveBeenCalled();
    expect(ports.native.getBlob).not.toHaveBeenCalled(); expect(ports.native.confirmIntent).toHaveBeenCalledWith({ requestId: old.requestId, receipt: accepted(imported) });
    expect(JSON.parse(imported.serializedBody)).toEqual({ requestId: old.requestId, text: old.text, attachments: old.attachments });
    expect(facade.getSnapshot().text).toBe('Raw original A');
  });
  it.each(['missing', 'different-manifest', 'promotion-failed'])('keeps original identity held when explicit historical Check is %s', async kind => {
    const { facade, old, imported } = legacyPending();
    const legacyKey = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id));
    expect(legacyKey).toBeTruthy(); const originalRaw = localStorage.getItem(legacyKey);
    expect(JSON.parse(originalRaw).pending).toMatchObject({ requestId: old.requestId, text: old.text, attachments: old.attachments });
    if (kind === 'promotion-failed') ports.native.promoteLegacy.mockRejectedValueOnce(new Error('Synthetic promotion quota failure'));
    apiFetch.mockResolvedValue(kind === 'missing' ? response(null, 404) : response(accepted(imported, { input: { text: imported.text, attachments: [{ ...A, name: 'other.png' }] } })));
    const hook = mount(); let result, caught;
    await act(async () => { try { result = await hook.result.current.checkPendingMessage?.(); } catch (error) { caught = error; } });
    expect(ports.native.promoteLegacy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(legacyKey)).toBe(originalRaw);
    expect(facade.getSnapshot().text).toBe('Raw original A');
    if (kind === 'promotion-failed') {
      expect(caught?.message).toMatch(/quota/);
      expect(facade.getImageStore()).toBe(ports.native);
      expect(ports.native.getSnapshot()).toMatchObject({ storageState: 'legacy', pending: imported, text: 'Raw original A' });
    } else if (kind === 'missing') expect(result).toMatchObject({ accepted: false, unknown: true });
    else expect(caught?.message).toMatch(/receipt|manifest|confirm/i);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(kind === 'promotion-failed' ? 0 : 1);
    expect(ports.native.confirmIntent).not.toHaveBeenCalled(); expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(ports.native.getBlob).not.toHaveBeenCalled();
    expect(ports.native.getPendingIntent()).toEqual(imported);
    expect(facade.getSnapshot().pending).toEqual(imported);
    expect(JSON.parse(ports.native.getPendingIntent().serializedBody)).toEqual({ requestId: old.requestId, text: old.text, attachments: old.attachments });
  });
});
