import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createUserImageDraftStore, decodeUserImageDraftHead } from './userImageDraftStore';

// Pure metadata fixtures only. Hash-shaped descriptor values here are not a
// substitute for the native-browser fixture's actual PNG Blob/hash proof.
const SCOPE = ['idb-unit-owner', 'https://fixture.invalid/v4/home/', 'home', 'ss-1234567890abcdef1234567890abcdef'];
const AUTHORITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCAL_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LOCAL_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const B = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/webp', bytes: 68, name: 'second.webp' };
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

function pending(overrides = {}) {
  const text = '\ufeff\u0085Cafe\u0301\nkept\u0085\ufeff';
  const serializedBody = JSON.stringify({ requestId: REQUEST, text, attachments: [A, B] });
  return {
    kind: 'images-v1', requestId: REQUEST, text, attachments: copy([A, B]),
    draftRevision: REVISION, submittedLocalIds: [LOCAL_A, LOCAL_B], missingBytePins: [],
    serializedBody, serializedBodySha256: sha(serializedBody),
    rawSourceEvidence: { kind: 'draft', revision: REVISION, localIds: [LOCAL_A, LOCAL_B] },
    acceptedReceipt: null, ...overrides,
  };
}

function head(overrides = {}) {
  return {
    schemaVersion: 1, scope: [...SCOPE], authorityId: AUTHORITY, headRevision: 1,
    draft: { revision: REVISION, rawText: '\ufeff\u0085Cafe\u0301\r\nkept\u0085\ufeff', localIds: [LOCAL_A, LOCAL_B] },
    pending: pending(), removals: [],
    migration: {
      state: 'ready', legacyRaw: null, legacySourceSha256: null,
      expectedMarker: JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: SCOPE, authorityId: AUTHORITY, legacySourceSha256: null }),
      observedConflict: null,
    }, ...overrides,
  };
}

function expectCode(action, code) {
  let caught;
  try { action(); } catch (error) { caught = error; }
  expect(caught, 'operation must fail closed').toBeDefined();
  expect(caught.code).toBe(code);
}

function options(overrides = {}) {
  return {
    scope: [...SCOPE], indexedDB: null, IDBKeyRange: null,
    legacy: { readRaw: vi.fn(() => null), writeMarker: vi.fn() },
    signal: new AbortController().signal, isCurrent: () => true,
    initialDraft: { text: 'Original unsaved raw text\r\n\ufeff', revision: REVISION },
    ...overrides,
  };
}

describe('new image draft head codec — pure contract, not IDB proof', () => {
  it('preserves exact canonical/body identity and raw text in a cloned immutable valid head', () => {
    const value = head(); const decoded = decodeUserImageDraftHead(value, SCOPE);
    expect(decoded).toEqual(value); expect(decoded).not.toBe(value);
    expect(decoded.pending.serializedBody).toBe(value.pending.serializedBody);
    expect(decoded.draft.rawText).toBe(value.draft.rawText);
    expect(Object.isFrozen(decoded)).toBe(true); expect(Object.isFrozen(decoded.pending.attachments)).toBe(true);
    value.pending.attachments[0].name = 'mutated.png';
    expect(decoded.pending.attachments[0].name).toBe('first.png');
  });

  it('rejects wrong owner/full-home-path/environment/session and unexpected record fields', () => {
    const values = [head({ extra: true }), ...SCOPE.map((_part, index) => {
      const value = head(); value.scope[index] += '-other'; return value;
    })];
    for (const value of values) expectCode(() => decodeUserImageDraftHead(value, SCOPE), 'corrupt');
  });

  it('rejects sparse descriptors and body/order/descriptor tampering without changing the source', () => {
    for (const mutate of [
      value => { delete value.pending.attachments[0]; },
      value => { value.pending.attachments.reverse(); },
      value => { value.pending.attachments[0].bytes = 0; },
      value => { value.pending.attachments[0].path = '/private/not-authority.png'; },
      value => { value.pending.serializedBody = JSON.stringify({ requestId: REQUEST, text: value.pending.text, attachments: [B, A] }); },
    ]) {
      const value = head(); mutate(value); const before = JSON.stringify(value);
      expectCode(() => decodeUserImageDraftHead(value, SCOPE), 'corrupt');
      expect(JSON.stringify(value)).toBe(before);
    }
  });

  it('rejects unknown pending/migration/source enums and malformed nullable receipt', () => {
    for (const mutate of [
      value => { value.pending.kind = 'automatic-image-send'; },
      value => { value.migration.state = 'uploaded'; },
      value => { value.pending.rawSourceEvidence.kind = 'guessed'; },
      value => { value.pending.acceptedReceipt = { status: 'accepted', requestId: REQUEST }; },
      value => { value.pending.serializedBody = JSON.stringify({ requestId: REQUEST, text: value.pending.text, attachments: [A, B], endpoint: 'https://fixture.invalid/other' }); },
    ]) {
      const value = head(); mutate(value);
      expectCode(() => decodeUserImageDraftHead(value, SCOPE), 'corrupt');
    }
  });

  it('rejects unsafe revisions and duplicate or foreign local identity bindings', () => {
    for (const mutate of [
      value => { value.headRevision = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.headRevision = -1; },
      value => { value.draft.revision = 'not-a-revision'; },
      value => { value.draft.localIds = [LOCAL_A, LOCAL_A]; },
      value => { value.pending.submittedLocalIds = [LOCAL_A]; },
    ]) {
      const value = head(); mutate(value);
      expectCode(() => decodeUserImageDraftHead(value, SCOPE), 'corrupt');
    }
  });

  it('imports exact legacy text UUID/raw snapshot and old newline body without applying image projection', () => {
    const text = ' \ufeff\u0085legacy\r\ntext\u0085\ufeff ';
    const legacy = { version: 1, home: SCOPE[1].replace(/\/$/, ''), sessionId: SCOPE[3], text, revision: REVISION,
      pending: { requestId: REQUEST, text, draftRevision: REVISION } };
    const serializedBody = JSON.stringify({ text: `${text}\n`, fallbackToMessage: true, requestId: REQUEST });
    const value = head({ draft: { revision: REVISION, rawText: text, localIds: [] }, pending: {
      kind: 'legacy-text-v1', requestId: REQUEST, text, draftRevision: REVISION, submittedLocalIds: [], missingBytePins: [],
      serializedBody, serializedBodySha256: sha(serializedBody), rawSourceEvidence: { kind: 'draft', revision: REVISION, localIds: [] }, acceptedReceipt: null,
    } });
    value.migration.legacyRaw = JSON.stringify(legacy); value.migration.legacySourceSha256 = sha(value.migration.legacyRaw);
    value.migration.expectedMarker = JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: SCOPE, authorityId: AUTHORITY, legacySourceSha256: value.migration.legacySourceSha256 });
    const decoded = decodeUserImageDraftHead(value, SCOPE);
    expect(decoded.pending.requestId).toBe(REQUEST); expect(decoded.pending.text).toBe(text);
    expect(decoded.pending.serializedBody).toBe(serializedBody); expect(decoded.migration.legacyRaw).toBe(value.migration.legacyRaw);
  });

  it('keeps legacy image identity with missing-byte pins and an independently newer raw draft', () => {
    const value = head({ draft: { revision: crypto.randomUUID(), rawText: 'Newer raw text\r\nkept ', localIds: [] } });
    value.pending.missingBytePins = [{ localId: LOCAL_A, attachment: copy(A) }, { localId: LOCAL_B, attachment: copy(B) }];
    value.pending.rawSourceEvidence = { kind: 'legacy_image_unknown' };
    const decoded = decodeUserImageDraftHead(value, SCOPE);
    expect(decoded.draft).toEqual(value.draft); expect(decoded.pending.requestId).toBe(REQUEST);
    expect(decoded.pending.attachments).toEqual([A, B]); expect(decoded.pending.missingBytePins).toEqual(value.pending.missingBytePins);
    expect(decoded.pending.serializedBody).toBe(value.pending.serializedBody);
    expect(decoded.pending.acceptedReceipt).toBeNull();
  });

  it('rejects an accepted image receipt without ordinary message identity or exact input echo', () => {
    const receipt = { status: 'accepted', requestId: REQUEST, turnId: 'turn-fixture', messageId: 'message-fixture', acceptedSeq: 12, input: { text: pending().text, attachments: copy([A, B]) } };
    for (const mutate of [
      value => { delete value.pending.acceptedReceipt.messageId; },
      value => { value.pending.acceptedReceipt.requestId = crypto.randomUUID(); },
      value => { delete value.pending.acceptedReceipt.input; },
      value => { value.pending.acceptedReceipt.input.attachments.reverse(); },
    ]) {
      const value = head(); value.pending.acceptedReceipt = copy(receipt); mutate(value);
      expectCode(() => decodeUserImageDraftHead(value, SCOPE), 'corrupt');
    }
  });
});

describe('new image draft adapter consumer boundaries — no fake IDB durability', () => {
  it('constructs and reads the initial raw buffer without opening IDB or starting legacy writes/network', () => {
    const indexedDB = { open: vi.fn(() => { throw new Error('Constructor must not open'); }) };
    const config = options({ indexedDB }); const store = createUserImageDraftStore(config);
    const snapshot = store.getSnapshot();
    expect(snapshot.text).toBe(config.initialDraft.text); expect(snapshot.revision).toBe(REVISION);
    expect(snapshot.scopeKey).toBe(JSON.stringify(SCOPE)); expect(snapshot.storageState).toBe('legacy');
    expect(indexedDB.open).not.toHaveBeenCalled(); expect(config.legacy.readRaw).not.toHaveBeenCalled(); expect(config.legacy.writeMarker).not.toHaveBeenCalled();
  });

  it('retains visible raw input and returns unavailable when native IDB cannot be opened', async () => {
    const config = options(); const store = createUserImageDraftStore(config);
    await expect(store.hydrate()).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.getSnapshot().text).toBe(config.initialDraft.text); expect(store.getSnapshot().error.code).toBe('unavailable');
    expect(config.legacy.writeMarker).not.toHaveBeenCalled();
  });

  it('blocks preparation before hydration/promotion instead of replacing a possible stored request', async () => {
    const store = createUserImageDraftStore(options());
    await expect(store.prepareIntent({ text: 'canonical', attachments: [A], draftRevision: REVISION, localIds: [LOCAL_A] })).rejects.toMatchObject({ code: 'not_ready' });
    expect(store.getSnapshot().text).toBe('Original unsaved raw text\r\n\ufeff');
  });

  it('rejects an obsolete live scope before any native or legacy read', async () => {
    const indexedDB = { open: vi.fn() }; const config = options({ indexedDB, isCurrent: () => false });
    const store = createUserImageDraftStore(config);
    await expect(store.hydrate()).rejects.toMatchObject({ code: 'stale_scope' });
    expect(indexedDB.open).not.toHaveBeenCalled(); expect(config.legacy.readRaw).not.toHaveBeenCalled(); expect(config.legacy.writeMarker).not.toHaveBeenCalled();
  });

  it('rejects invalid scope tuples without consulting a DB or legacy key', () => {
    for (const scope of [
      ['', ...SCOPE.slice(1)],
      [SCOPE[0], 'https://person:secret@fixture.invalid/v4/home/', SCOPE[2], SCOPE[3]],
      [SCOPE[0], 'https://fixture.invalid/v4/home/?query=1', SCOPE[2], SCOPE[3]],
      [SCOPE[0], SCOPE[1], 'home', ''],
      [SCOPE[0], SCOPE[1], 'home', SCOPE[3], 'extra'],
    ]) {
      const config = options({ scope }); expectCode(() => createUserImageDraftStore(config), 'invalid_scope');
      expect(config.legacy.readRaw).not.toHaveBeenCalled(); expect(config.legacy.writeMarker).not.toHaveBeenCalled();
    }
  });

  it('updates displayed text immediately without claiming it committed before a successful flush', async () => {
    const store = createUserImageDraftStore(options()); store.setText('A'); store.setText('Newer B\r\n');
    expect(store.getSnapshot().text).toBe('Newer B\r\n');
    expect(store.getSnapshot().committedRevision).not.toBe(store.getSnapshot().revision);
    await expect(store.flush()).rejects.toMatchObject({ code: 'unavailable' });
    expect(store.getSnapshot().text).toBe('Newer B\r\n'); expect(store.getSnapshot().error.code).toBe('unavailable');
  });

  it('unsubscribing one listener does not close another active observer', () => {
    const store = createUserImageDraftStore(options()); const a = vi.fn(), b = vi.fn();
    const releaseA = store.subscribe(a); const releaseB = store.subscribe(b); releaseA();
    store.setText('Still visible to B');
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalled(); expect(store.getSnapshot().text).toBe('Still visible to B');
    releaseB();
    // Controller view refcount, URL revocation and HTTP abort remain later gates.
  });

  it('final close fences later operations while retaining the current visible draft', async () => {
    const indexedDB = { open: vi.fn() }; const config = options({ indexedDB }); const store = createUserImageDraftStore(config);
    store.close();
    await expect(store.hydrate()).rejects.toMatchObject({ code: 'closed' });
    await expect(store.prepareIntent({ text: 'canonical', attachments: [A], draftRevision: REVISION, localIds: [LOCAL_A] })).rejects.toMatchObject({ code: 'closed' });
    expect(store.getSnapshot().storageState).toBe('closed'); expect(store.getSnapshot().text).toBe(config.initialDraft.text);
    expect(indexedDB.open).not.toHaveBeenCalled(); expect(config.legacy.writeMarker).not.toHaveBeenCalled();
  });
});
