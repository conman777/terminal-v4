import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getComposerDraftStore } from './composerDraftStore';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';

const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const B = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/webp', bytes: 68, name: 'second.webp' };
const sessionId = 'ss-durable-image-metadata-fixture';
const savedKey = () => { const keys = Object.keys(localStorage).filter(key => key.includes('composerDraft:') && key.endsWith(':' + sessionId)); expect(keys).toHaveLength(1); return keys[0]; };
const reopen = () => { setEnvironmentIdentity(null); setEnvironmentIdentity('image-store-fixture', window.location.origin); return getComposerDraftStore(sessionId); };

beforeEach(() => { localStorage.clear(); setEnvironmentIdentity('image-store-fixture', window.location.origin); setActiveEnvironment(null); });
afterEach(() => { vi.restoreAllMocks(); setEnvironmentIdentity(null); localStorage.clear(); });

describe('scoped composer image intent metadata foundation', () => {
  it('publishes persisted canonical text and ordered refs while keeping raw draft text and revision separate', async () => {
    const store = getComposerDraftStore(sessionId), raw = ' \u0085Cafe\u0301\r\ntext \n'; store.setText(raw); const revision = store.getSnapshot().revision;
    const intent = await store.prepareIntent('Cafe\u0301\ntext', [A, B]); const saved = JSON.parse(localStorage.getItem(savedKey()));
    expect(saved.text).toBe(raw); expect(saved.revision).toBe(revision); expect(saved.pending).toEqual(store.getSnapshot().pending);
    expect(saved.pending).toEqual({ requestId: intent.requestId, text: 'Cafe\u0301\ntext', draftRevision: revision, attachments: [A, B] });
  });
  it('restores exact frozen image metadata after the owner scope remount without projecting again', async () => {
    const store = getComposerDraftStore(sessionId); store.setText('\ufeff\u0085text\u0085\ufeff'); const first = await store.prepareIntent('\ufeff\u0085text\u0085\ufeff', [A, B]);
    const restored = reopen(); const second = await restored.prepareIntent('\ufeff\u0085text\u0085\ufeff', [A, B]);
    expect(second).toEqual({ ...first, reused: true }); expect(restored.getSnapshot().text).toBe('\ufeff\u0085text\u0085\ufeff');
  });
  it('retains one unresolved image body across changed images, text, or a text-only send', async () => {
    const store = getComposerDraftStore(sessionId); store.setText('raw'); await store.prepareIntent('frozen', [A]); const before = structuredClone(store.getSnapshot().pending), bytes = localStorage.getItem(savedKey());
    for (const args of [['frozen', [B]], ['changed', [A]], ['frozen']]) await expect(Promise.resolve().then(() => store.prepareIntent(...args))).rejects.toThrow(/pending|unresolved|confirm|image/i);
    expect(store.getSnapshot().pending).toEqual(before); expect(localStorage.getItem(savedKey())).toBe(bytes);
  });
  it('does not replace an uncertain text identity with an image manifest while preserving legacy text replacement', async () => {
    const store = getComposerDraftStore(sessionId); const first = await store.prepareIntent('old text'); const second = await store.prepareIntent('new text'); expect(second.requestId).not.toBe(first.requestId);
    await expect(Promise.resolve().then(() => store.prepareIntent('new text', [A]))).rejects.toThrow(); expect(store.getSnapshot().pending.requestId).toBe(second.requestId);
  });
  it('requires the metadata write before image intent success and keeps the previous draft on quota failure', async () => {
    const store = getComposerDraftStore(sessionId); store.setText('preserve raw'); const before = structuredClone(store.getSnapshot()), bytes = localStorage.getItem(savedKey());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Synthetic metadata quota', 'QuotaExceededError'); });
    await expect(Promise.resolve().then(() => store.prepareIntent('preserve raw', [A]))).rejects.toThrow(/save|storage|persist/i);
    expect(store.getSnapshot().text).toBe(before.text); expect(store.getSnapshot().revision).toBe(before.revision); expect(store.getSnapshot().pending).toEqual(before.pending); expect(localStorage.getItem(savedKey())).toBe(bytes);
  });
  it('rejects a malformed persisted image manifest without overwriting its possible request identity', async () => {
    const store = getComposerDraftStore(sessionId); store.setText('preserve raw'); await store.prepareIntent('preserve raw', [A]); const key = savedKey(), value = JSON.parse(localStorage.getItem(key)); value.pending.attachments[0].bytes = -1; const corrupt = JSON.stringify(value); localStorage.setItem(key, corrupt);
    const restored = reopen(); expect(restored.getSnapshot().error).toMatch(/read/i);
    await expect(Promise.resolve().then(() => restored.prepareIntent('preserve raw', [A]))).rejects.toThrow(/read|save|storage/i); expect(localStorage.getItem(key)).toBe(corrupt);
  });
});
