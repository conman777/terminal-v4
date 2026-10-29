import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompactionIntentStore } from './compactionIntentStore';
import { getComposerDraftStore } from './composerDraftStore';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { CONTEXT_SESSION, CONTEXT_REVISION, compactReceipt } from '../test/compactionFixtures';
const scope = (owner = 'compact-owner', home = 'https://compact.example/base') => { setEnvironmentIdentity(owner, home); setActiveEnvironment(null); };
const savedKey = () => Object.keys(localStorage).find(key => key.includes('compactionIntent:'));
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); scope(); });
afterEach(() => { vi.restoreAllMocks(); setEnvironmentIdentity(null); localStorage.clear(); });

describe('separate scoped compaction instructions and immutable intent', () => {
  it('persists exact whitespace/null body plus UUID and draft revision before submission', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('  preserve decisions\n');
    const revision = store.getSnapshot().draftRevision, intent = store.prepareIntent(CONTEXT_REVISION);
    const saved = JSON.parse(localStorage.getItem(savedKey()));
    expect(saved.pending).toEqual(intent);
    expect(intent.body).toMatchObject({ instructions: '  preserve decisions\n', expectedRevision: CONTEXT_REVISION });
    expect(intent.body.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(intent.draftRevision).toBe(revision);
  });
  it('represents an empty optional instruction as null without trimming a nonempty instruction', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION);
    expect(store.prepareIntent(CONTEXT_REVISION).body.instructions).toBeNull();
  });
  it('refuses to replace an unresolved command after instructions or context revision change', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('original'); const first = store.prepareIntent(CONTEXT_REVISION);
    store.setInstructions('newer text');
    expect(() => store.prepareIntent('b'.repeat(64))).toThrow(/pending|unresolved|confirm/i);
    expect(store.getSnapshot().pending.body).toEqual(first.body); expect(store.getSnapshot().instructions).toBe('newer text');
  });
  it('shares a same-window single-flight lease without claiming cross-window execution coordination', () => {
    const first = getCompactionIntentStore(CONTEXT_SESSION), second = getCompactionIntentStore(CONTEXT_SESSION);
    const lease = first.claim(); expect(lease).toBeTruthy(); expect(second.claim()).toBeNull();
    second.release({}); expect(first.getSnapshot().isSending).toBe(true);
    first.release(lease); expect(second.getSnapshot().isSending).toBe(false);
  });
  it('clears only the submitted instruction revision on a matching acceptance', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('same'); const first = store.prepareIntent(CONTEXT_REVISION);
    store.setInstructions('edit'); store.setInstructions('same'); store.accept(compactReceipt(first.body.requestId));
    expect(store.getSnapshot().instructions).toBe('same'); expect(store.getSnapshot().pending.body).toEqual(first.body);
  });
  it('clears the unchanged submitted instructions on acceptance but retains the command until terminal reconciliation', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('submitted'); const intent = store.prepareIntent(CONTEXT_REVISION);
    store.accept(compactReceipt(intent.body.requestId));
    expect(store.getSnapshot().instructions).toBe(''); expect(store.getSnapshot().pending.body).toEqual(intent.body);
    expect(store.getSnapshot().pending.receipt.requestId).toBe(intent.body.requestId);
  });
  it('leaves ordinary composer and queued draft storage unchanged', () => {
    const composer = getComposerDraftStore(CONTEXT_SESSION); composer.setText('main draft');
    localStorage.setItem('synthetic-queue-draft', 'queued draft');
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('summary directions'); const intent = store.prepareIntent(CONTEXT_REVISION);
    store.accept(compactReceipt(intent.body.requestId));
    expect(composer.getSnapshot().text).toBe('main draft'); expect(localStorage.getItem('synthetic-queue-draft')).toBe('queued draft');
  });
  it('isolates owner, full home path, environment and session, restoring the original persisted UUID', () => {
    let store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('owner A'); const original = store.prepareIntent(CONTEXT_REVISION);
    setActiveEnvironment({ id: 'remote-fixture' }); expect(getCompactionIntentStore(CONTEXT_SESSION).getSnapshot().pending).toBeNull();
    scope('other-owner'); expect(getCompactionIntentStore(CONTEXT_SESSION).getSnapshot().instructions).toBe('');
    scope('compact-owner', 'https://compact.example/other-base'); expect(getCompactionIntentStore(CONTEXT_SESSION).getSnapshot().pending).toBeNull();
    scope(); expect(getCompactionIntentStore('ss-00000000000000000000000000000032').getSnapshot().pending).toBeNull();
    store = getCompactionIntentStore(CONTEXT_SESSION); expect(store.getSnapshot().pending.body).toEqual(original.body);
  });
  it('does not persist a required intent when device storage fails, and keeps visible instructions', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('keep text');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota'); });
    expect(() => store.prepareIntent(CONTEXT_REVISION)).toThrow(/save|storage/i);
    expect(store.getSnapshot().instructions).toBe('keep text'); expect(store.getSnapshot().pending).toBeNull();
  });
  it('preserves corrupt records without overwriting their possible unresolved identity', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('saved'); const key = savedKey();
    localStorage.setItem(key, '{corrupt compact intent'); scope('other'); scope();
    const recovered = getCompactionIntentStore(CONTEXT_SESSION); recovered.setInstructions('visible edit');
    expect(() => recovered.prepareIntent(CONTEXT_REVISION)).toThrow(/read|saved|identity/i);
    expect(localStorage.getItem(key)).toBe('{corrupt compact intent'); expect(recovered.getSnapshot().instructions).toBe('visible edit');
  });
  it('rejects a stale writer instead of overwriting an intent persisted by another window', () => {
    const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('local'); const key = savedKey();
    const remote = JSON.parse(localStorage.getItem(key)); remote.instructions = 'other window'; remote.draftRevision = crypto.randomUUID();
    localStorage.setItem(key, JSON.stringify(remote));
    expect(() => store.prepareIntent(CONTEXT_REVISION)).toThrow(/changed|another|reload/i);
    expect(JSON.parse(localStorage.getItem(key)).instructions).toBe('other window');
  });
});

it.each([
  ['pending enum', value => { value.pending.phase = 'invented'; }],
  ['changed command body', value => { value.pending.body.extra = 'unsupported'; }],
  ['invalid command revision', value => { value.pending.body.expectedRevision = 'not-a-revision'; }],
  ['invalid instructions', value => { value.pending.body.instructions = '\u0085'; }],
  ['mismatched receipt', value => { value.pending.receipt = compactReceipt('00000000-0000-4000-8000-000000000099'); }],
  ['invalid receipt status', value => { value.pending.receipt = compactReceipt(value.pending.body.requestId, { status: 'invented' }); }],
])('blocks malformed persisted %s without overwriting the original record', (_name, corrupt) => {
  const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('saved'); store.prepareIntent(CONTEXT_REVISION);
  const key = savedKey(), value = JSON.parse(localStorage.getItem(key)); corrupt(value);
  const raw = JSON.stringify(value); localStorage.setItem(key, raw); scope('other'); scope();
  const restored = getCompactionIntentStore(CONTEXT_SESSION);
  expect(() => restored.prepareIntent(CONTEXT_REVISION)).toThrow(/saved|read|identity|invalid/i);
  expect(localStorage.getItem(key)).toBe(raw);
});

it('restores a temporarily unreadable pending command without discarding newer visible instruction edits', () => {
  const initial = getCompactionIntentStore(CONTEXT_SESSION); initial.setInstructions('original'); const original = initial.prepareIntent(CONTEXT_REVISION);
  scope('other'); scope(); let unavailable = true; const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(key) { if (unavailable && key.includes('compactionIntent:')) throw new Error('Synthetic read failure'); return getItem.call(this, key); });
  const restored = getCompactionIntentStore(CONTEXT_SESSION); restored.setInstructions('newer visible text'); unavailable = false; restored.refresh();
  expect(restored.getSnapshot().pending.body).toEqual(original.body); expect(restored.getSnapshot().instructions).toBe('newer visible text');
});
it('does not trust malformed persisted terminal history metrics', () => {
  const initial = getCompactionIntentStore(CONTEXT_SESSION); initial.setInstructions('original'); const intent = initial.prepareIntent(CONTEXT_REVISION);
  initial.accept(compactReceipt(intent.body.requestId)); const key = savedKey(), value = JSON.parse(localStorage.getItem(key));
  value.pending = null; value.lastCommand = { body: intent.body, outcome: { status: 'completed', turnId: 'turn-compact-fixture', acceptedSeq: 9, detailsUnavailable: false, receipt: { beforeBytes: -1, afterBytes: 0 } } };
  const raw = JSON.stringify(value); localStorage.setItem(key, raw); scope('other'); scope(); const restored = getCompactionIntentStore(CONTEXT_SESSION);
  expect(() => restored.prepareIntent(CONTEXT_REVISION)).toThrow(/saved|read|identity/i); expect(localStorage.getItem(key)).toBe(raw);
});

it('retries saving recovered device storage explicitly without replacing an unresolved identity', () => {
  const store = getCompactionIntentStore(CONTEXT_SESSION); store.setInstructions('submitted'); const original = store.prepareIntent(CONTEXT_REVISION);
  const setItem = Storage.prototype.setItem; let full = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(key, value) { if (full && key.includes('compactionIntent:')) throw new Error('Synthetic quota'); return setItem.call(this, key, value); });
  store.setInstructions('newer unsaved instructions'); expect(store.getSnapshot().error).toMatch(/save/i);
  full = false; expect(store.retrySave()).toBe(true);
  expect(store.getSnapshot().error).toBe(''); expect(store.getSnapshot().instructions).toBe('newer unsaved instructions'); expect(store.getSnapshot().pending.body).toEqual(original.body);
  expect(JSON.parse(localStorage.getItem(savedKey())).instructions).toBe('newer unsaved instructions');
});
