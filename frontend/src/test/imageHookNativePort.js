// Native producer substitute for transport-consumer tests only. These are three
// authored snapshots (ready/prepared/settled), not persistence, a reducer, IDB,
// hashing, upload, migration or CAS. Canonical text is supplied by each test.
import { expect, vi } from 'vitest';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';
import { getEnvironmentSignal } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';
const scripts = new Map();
export function resetImagePorts() { for (const value of scripts.values()) value.close(); scripts.clear(); }
export function scriptedImageStore(options) {
  const value = scripts.get(JSON.stringify(options.scope));
  if (!value) throw new Error('This test did not author a ready native producer for the requested scope.');
  return value;
}
export async function readyImagePort({ sessionId, raw, canonical, attachments }) {
  const auth = captureAuthScope(), signal = getEnvironmentSignal(), scope = [auth.userId, auth.home, 'home', sessionId], key = JSON.stringify(scope);
  const facade = getComposerDraftStore(sessionId);
  if (!scripts.has(key)) {
    facade.setText(raw);
    const revision = facade.getSnapshot().revision, refs = structuredClone(attachments), localIds = refs.map(() => crypto.randomUUID());
    const requestId = crypto.randomUUID(), authorityId = crypto.randomUUID();
    const input = { requestId, text: canonical, attachments: refs };
    const pending = Object.freeze({ kind: 'images-v1', ...input, draftRevision: revision, submittedLocalIds: localIds, missingBytePins: [],
      serializedBody: JSON.stringify(input), serializedBodySha256: '0'.repeat(64), rawSourceEvidence: { kind: 'draft', revision, localIds }, acceptedReceipt: null, reused: false });
    const initial = { scopeKey: key, storageState: 'ready', authorityId, headRevision: 1, text: raw, revision, committedRevision: revision, localIds,
      items: refs.map((descriptor, index) => ({ localId: localIds[index], name: descriptor.name, mimeType: descriptor.mimeType, bytes: descriptor.bytes,
        durability: 'saved', uploadState: 'ready', uploadId: descriptor.attachmentId, uploadGeneration: 1, descriptor, errorCode: null })),
      pending: null, removals: [], isHydrating: false, isSaving: false, error: null, conflict: null, migration: null };
    const prepared = { ...initial, headRevision: 2, pending }, settled = { ...initial, headRevision: 3 };
    let current = initial; const listeners = new Set();
    const publish = value => { current = value; for (const listener of listeners) listener(); };
    const blobs = new Map(refs.map((ref, index) => [localIds[index], Object.freeze({ blob: new File([new Uint8Array(ref.bytes)], ref.name, { type: ref.mimeType }),
      localId: localIds[index], uploadId: ref.attachmentId, name: ref.name, mimeType: ref.mimeType, bytes: ref.bytes, artifactId: ref.artifactId, rawSha256: '0'.repeat(64) })]));
    const native = { getSnapshot: () => current, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      hydrate: vi.fn(async () => current), promoteLegacy: vi.fn(async () => current), flush: vi.fn(async () => ({ committed: true, headRevision: current.headRevision, revision, snapshot: current })),
      prepareIntent: vi.fn(async input => {
        // A controlled producer checks its port input; it must not conceal an
        // incorrect projector, source revision, manifest or ordered pin list.
        expect(input).toEqual({ text: canonical, attachments: refs, draftRevision: revision, localIds });
        publish(prepared); return pending;
      }), getPendingIntent: () => current.pending,
      getBlob: vi.fn(async localId => { if (!blobs.has(localId)) throw new Error('Unknown authored pin'); return blobs.get(localId); }),
      confirmIntent: vi.fn(async () => { publish(settled); return { committed: true, headRevision: 3, revision, clearedDraft: false, snapshot: settled }; }),
      close() { listeners.clear(); } };
    scripts.set(key, native);
  }
  const native = facade.observeImages({ scope, signal, isCurrent: () => !signal.aborted && isAuthScopeCurrent(auth) });
  await native.hydrate();
  return native;
}
