import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getComposerDraftStore } from './composerDraftStore';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';

const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const B = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/webp', bytes: 68, name: 'second.webp' };
const sessionId = 'ss-image-external-record-review';
const savedKey = () => {
  const keys = Object.keys(localStorage).filter(key => key.includes('composerDraft:') && key.endsWith(':' + sessionId));
  expect(keys).toHaveLength(1);
  return keys[0];
};

// Direct publication models another valid writer of this exact scoped key. It
// does not claim a transaction, native storage event, or cross-window locking.
function publishNewerImageIntent() {
  const key = savedKey(), old = JSON.parse(localStorage.getItem(key));
  const revision = crypto.randomUUID();
  const next = { ...old, text: 'Newer raw draft\r\nkept separately ', revision,
    pending: { requestId: crypto.randomUUID(), text: 'Newer canonical draft', draftRevision: revision, attachments: [B] } };
  const bytes = JSON.stringify(next);
  localStorage.setItem(key, bytes);
  return { key, bytes, next };
}

beforeEach(() => {
  localStorage.clear(); setEnvironmentIdentity('image-store-review-owner', window.location.origin); setActiveEnvironment(null);
});
afterEach(() => { vi.restoreAllMocks(); setEnvironmentIdentity(null); localStorage.clear(); });

describe('image intent metadata observed-writer barrier', () => {
  it.each([
    ['image', ['Old canonical draft', [A]]],
    ['ordinary text', ['Old ordinary draft']],
  ])('does not let stale %s preparation replace a newer persisted image identity', async (_label, args) => {
    const store = getComposerDraftStore(sessionId);
    store.setText('Old raw draft');
    const newer = publishNewerImageIntent();
    let accepted;
    try { accepted = await store.prepareIntent(...args); } catch { /* A stale writer may fail closed. */ }
    expect(localStorage.getItem(newer.key)).toBe(newer.bytes);
    expect(accepted?.requestId).not.toBeDefined();
    expect(JSON.parse(localStorage.getItem(newer.key))).toEqual(newer.next);
  });

  it('does not republish cached request A after another writer saved request B', async () => {
    const store = getComposerDraftStore(sessionId);
    store.setText('Old raw draft');
    const old = await store.prepareIntent('Old canonical draft', [A]);
    const newer = publishNewerImageIntent();
    let accepted;
    try { accepted = await store.prepareIntent('Old canonical draft', [A]); } catch { /* A stale writer may fail closed. */ }
    expect(localStorage.getItem(newer.key)).toBe(newer.bytes);
    expect(accepted?.requestId).not.toBe(old.requestId);
    expect(JSON.parse(localStorage.getItem(newer.key)).pending).toEqual(newer.next.pending);
  });

  it('does not let confirmation of cached A erase a newer raw draft and pending B', async () => {
    const store = getComposerDraftStore(sessionId);
    store.setText('Old raw draft');
    const old = await store.prepareIntent('Old canonical draft', [A]);
    const newer = publishNewerImageIntent();
    try { await store.confirmIntent(old.requestId); } catch { /* A stale confirmation may fail closed. */ }
    expect(localStorage.getItem(newer.key)).toBe(newer.bytes);
    const saved = JSON.parse(localStorage.getItem(newer.key));
    expect(saved.text).toBe(newer.next.text); expect(saved.revision).toBe(newer.next.revision);
    expect(saved.pending).toEqual(newer.next.pending);
  });

  it('does not let a stale raw text edit overwrite a newer persisted image intent', async () => {
    const store = getComposerDraftStore(sessionId);
    store.setText('Old raw draft');
    await store.prepareIntent('Old canonical draft', [A]);
    const newer = publishNewerImageIntent();
    try { store.setText('An edit from the stale view'); } catch { /* A stale writer may fail closed. */ }
    expect(localStorage.getItem(newer.key)).toBe(newer.bytes);
    const saved = JSON.parse(localStorage.getItem(newer.key));
    expect(saved.text).toBe(newer.next.text); expect(saved.revision).toBe(newer.next.revision);
    expect(saved.pending).toEqual(newer.next.pending);
  });

  it('does not let clearing an old draft revision erase newer raw text or pending B', async () => {
    const store = getComposerDraftStore(sessionId);
    store.setText('Old raw draft');
    const oldRevision = store.getSnapshot().revision;
    await store.prepareIntent('Old canonical draft', [A]);
    const newer = publishNewerImageIntent();
    try { store.clearIfUnchanged(oldRevision, 'Old raw draft'); } catch { /* A stale clear may fail closed. */ }
    expect(localStorage.getItem(newer.key)).toBe(newer.bytes);
    const saved = JSON.parse(localStorage.getItem(newer.key));
    expect(saved.text).toBe(newer.next.text); expect(saved.revision).toBe(newer.next.revision);
    expect(saved.pending).toEqual(newer.next.pending);
  });
});
