// UNAPPLIED test-only controlled native port. No IndexedDB, hashes, migration,
// quota, CAS or durability is modeled. `commits` means only this synthetic
// pre-commit guard allowed the explicitly authored ready publication.
import { vi } from 'vitest';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { A, B, L1, L2, R1, R2, SESSION, REQUEST, deferred, nativePort, ports, snapshot } from './userImagesJoinFixture';
import { L3, NEWER_TEXT, originalFile } from './userImagesOriginalsRecoveryFixture';

const HYDRATED_AUTHORITY = '12121212-1212-4212-8212-121212121212';
const PREPARED_AUTHORITY = '13131313-1313-4313-8313-131313131313';
const PREPARED_IDS = ['14141414-1414-4414-8414-141414141414', '15151515-1515-4515-8515-151515151515', '16161616-1616-4616-8616-161616161616'];
const MUTATIONS = ['addFiles', 'beginUpload', 'completeUpload', 'failUpload', 'removeImage', 'completeRemoval', 'prepareIntent', 'confirmIntent', 'flush', 'setText'];

export function legacyAdmissionFixture({ readyInitially = false, noMissingPins = false } = {}) {
  const attachments = [A, B, A], serializedBody = JSON.stringify({ requestId: REQUEST, text: 'Original image caption', attachments });
  const pending = ids => Object.freeze({ kind: 'images-v1', requestId: REQUEST, text: 'Original image caption', attachments,
    draftRevision: R1, submittedLocalIds: ids, missingBytePins: noMissingPins ? [] : ids.map((localId, i) => ({ localId, attachment: attachments[i] })),
    serializedBody, serializedBodySha256: 'c'.repeat(64), rawSourceEvidence: { kind: 'legacy_image_unknown' }, acceptedReceipt: null });
  const common = { text: NEWER_TEXT, revision: R2, committedRevision: R2, localIds: [], items: [], headRevision: 0 };
  const legacy = snapshot({ ...common, storageState: 'legacy', authorityId: HYDRATED_AUTHORITY, pending: pending([L1, L2, L3]), migration: { state: 'copy_committed' } });
  // Real first promotion may import the unchanged legacy request again, giving
  // it a new private authority and per-occurrence local IDs. This authored
  // snapshot deliberately exercises that valid consumer-side transition.
  const ready = snapshot({ ...common, storageState: 'ready', authorityId: PREPARED_AUTHORITY, headRevision: 2,
    pending: pending(PREPARED_IDS), migration: { state: 'ready' } });
  const gate = deferred(), entered = [], finished = [], commits = [], instances = [];
  let publishedMetadata = readyInitially ? ready : legacy, active = 0, peak = 0;
  const fixture = { legacy, ready, gate, entered, finished, commits, instances, failure: null, resolveNonReady: false,
    release: () => gate.resolve(), latest: () => instances.at(-1)?.native, peak: () => peak };
  const store = getComposerDraftStore(SESSION.id); store.setText(NEWER_TEXT);
  const legacyKey = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id));
  if (!legacyKey) throw new Error('The real facade did not create its own legacy key.');
  const legacyRaw = JSON.stringify({ version: 1, home: window.location.origin, sessionId: SESSION.id, text: NEWER_TEXT, revision: R2,
    pending: { requestId: REQUEST, text: legacy.pending.text, draftRevision: R1, attachments } });
  localStorage.setItem(legacyKey, legacyRaw); store.refresh();
  Object.assign(fixture, { store, legacyKey, legacyRaw });

  ports.nativeFactory.mockImplementation(options => {
    const native = nativePort(snapshot({ ...common, storageState: 'legacy', authorityId: null, pending: null, headRevision: null, committedRevision: null }));
    let closed = false;
    const record = { native, options, hydrateReads: [] }; instances.push(record); ports.native = native;
    const isCurrent = () => !closed && !options.signal?.aborted && options.isCurrent();
    native.hydrate.mockImplementation(async () => {
      const allowed = isCurrent(); record.hydrateReads.push(allowed);
      if (!allowed) throw Object.assign(new Error('Controlled native read scope retired'), { code: 'stale_scope' });
      native.publish(publishedMetadata); return publishedMetadata;
    });
    native.promoteLegacy.mockImplementation(async () => {
      const attempt = { record, commitGuard: null }; entered.push(attempt); active += 1; peak = Math.max(peak, active);
      try {
        await gate.promise;
        attempt.commitGuard = isCurrent();
        if (!attempt.commitGuard) throw Object.assign(new Error('Controlled pre-commit scope retired'), { code: 'stale_scope' });
        if (fixture.failure) throw Object.assign(new Error(`Controlled promotion ${fixture.failure}`), { code: fixture.failure });
        if (fixture.resolveNonReady) return native.getSnapshot();
        publishedMetadata = ready; commits.push(attempt); native.publish(ready); return ready;
      } finally { active -= 1; finished.push(attempt); }
    });
    native.restorePendingBytes.mockImplementation(async ({ requestId, files }) => {
      if (!isCurrent() || native.getSnapshot().storageState !== 'ready') throw Object.assign(new Error('Controlled native restore is not ready'), { code: 'not_ready' });
      if (requestId !== REQUEST || !Array.isArray(files) || files.length !== 3) throw new Error('Wrong controlled restore request');
      const restored = { ...ready, pending: Object.freeze({ ...ready.pending, missingBytePins: [] }) };
      publishedMetadata = restored; native.publish(restored);
      return { committed: true, headRevision: restored.headRevision, revision: restored.revision, snapshot: restored };
    });
    native.close.mockImplementation(() => { closed = true; native.publish({ ...native.getSnapshot(), storageState: 'closed' }); });
    return native;
  });
  return fixture;
}

export const recoveryArgs = (recovery, slot) => ({ requestId: recovery.requestId, originalsRevision: recovery.revision,
  ...(slot === undefined ? {} : { slot }) });
export const viewArgs = (view, slot) => recoveryArgs({ requestId: view.pendingPreviousSend.requestId, revision: view.pendingPreviousSend.originalsRevision }, slot);
export const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
export function assertNoOtherMutation(fixture, expect) {
  for (const { native } of fixture.instances) for (const name of MUTATIONS) expect(native[name]).not.toHaveBeenCalled();
}
export const filesInPinOrder = () => { const first = originalFile(A); return [first, originalFile(B), first]; };
