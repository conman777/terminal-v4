// PREPARE ONLY. New proposed ports are absent from the current candidate.
// These consumer tests do not replace authoritative native-IDB recovery tests.
import { webcrypto } from 'node:crypto';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, controllerOptions, CATALOG, SESSION, A, B, deferred, response } from '../test/userImagesJoinFixture';
import { previous, seedPrevious, recoveredSnapshot, originalFile, committed, installSuccessfulRestore, noMutationSpies, OTHER_REQUEST, NEWER_TEXT, NEWER_LOCAL } from '../test/userImagesOriginalsRecoveryFixture';
vi.mock('./userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';
import { retainUserImageComposer } from './userImageComposerController';

let leases, priorHTTP;
beforeEach(() => {
  resetFixture(); leases = []; priorHTTP = null; seedPrevious();
  apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(null, 404));
});
afterEach(async () => { for (const lease of leases) lease.release(); await cleanFixture(); vi.unstubAllGlobals(); });
function retain(overrides) { const lease = retainUserImageComposer(controllerOptions(overrides)); leases.push(lease); return lease; }
async function ready(lease) {
  await waitFor(() => expect(lease.getSnapshot().recovery?.slots).toHaveLength(3));
  expect(typeof lease.selectOriginalImage).toBe('function'); expect(typeof lease.saveOriginalImages).toBe('function');
  if (!priorHTTP) priorHTTP = apiFetch.mock.calls.slice();
  return lease.getSnapshot().recovery;
}
const args = (recovery, slot) => ({ requestId: recovery.requestId, originalsRevision: recovery.revision, ...(slot === undefined ? {} : { slot }) });
const held = promise => promise.then(value => ({ value }), error => ({ error }));
async function selectAll(lease) {
  const recovery = lease.getSnapshot().recovery, b = originalFile(B), a = originalFile(A);
  await lease.selectOriginalImage(b, args(recovery, 0));
  await lease.selectOriginalImage(a, args(recovery, 1));
  await lease.selectOriginalImage(a, args(recovery, 2));
  return { recovery, files: [b, a, a] };
}
function assertNoTransportOrOtherMutation() {
  expect(apiFetch.mock.calls).toEqual(priorHTTP);
  expect(apiFetch.mock.calls.filter(([url]) => url !== '/api/agent/catalog')).toEqual([]);
  for (const spy of noMutationSpies(ports.native)) expect(spy).not.toHaveBeenCalled();
}

describe('explicit original-byte recovery at the real shared controller port', () => {
  it('[O01] exposes exactly ordered missing occurrences as metadata, including duplicate names, without files or private pin IDs', async () => {
    const lease = retain(), recovery = await ready(lease);
    expect(Object.keys(lease.getSnapshot()).sort()).toEqual(['scopeKey', 'generation', 'storage', 'admission', 'isAdding', 'uploadingIds', 'error', 'recovery'].sort());
    expect(lease.getSnapshot().uploadingIds).toEqual([]);
    expect(Object.keys(recovery).sort()).toEqual(['requestId', 'revision', 'state', 'canChoose', 'canSave', 'error', 'slots'].sort());
    expect(typeof recovery.error).toBe('string'); expect(recovery.canChoose).toBe(true);
    expect(Number.isSafeInteger(recovery.revision)).toBe(true);
    expect(recovery.slots).toEqual([B, A, A].map((item, slot) => ({ slot, name: item.name, mimeType: item.mimeType, bytes: item.bytes, selected: false })));
    expect(recovery.canSave).toBe(false); expect(recovery.state).toBe('missing');
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); assertNoTransportOrOtherMutation();
  });

  it('[O02] choosing the same File for two duplicate slots is transient; Save passes exactly missing-pin order only', async () => {
    const lease = retain(); await ready(lease); vi.stubGlobal('crypto', webcrypto); const uuid = vi.spyOn(webcrypto, 'randomUUID');
    const { recovery, files } = await selectAll(lease);
    expect(Object.keys(lease.getSnapshot()).sort()).toEqual(['scopeKey', 'generation', 'storage', 'admission', 'isAdding', 'uploadingIds', 'error', 'recovery'].sort());
    expect(lease.getSnapshot().uploadingIds).toEqual([]);
    const selected = lease.getSnapshot().recovery;
    expect(Object.keys(selected).sort()).toEqual(['requestId', 'revision', 'state', 'canChoose', 'canSave', 'error', 'slots'].sort());
    expect(selected.slots).toEqual([B, A, A].map((item, slot) => ({ slot, name: item.name, mimeType: item.mimeType, bytes: item.bytes, selected: true })));
    expect(typeof selected.error).toBe('string'); expect(selected.canChoose).toBe(true);
    expect(lease.getSnapshot().storage).toEqual(recoveredSnapshot(ports.native.getPendingIntent()));
    expect(lease.getSnapshot().recovery.slots.every(slot => slot.selected)).toBe(true);
    expect(lease.getSnapshot().recovery.canSave).toBe(true);
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); assertNoTransportOrOtherMutation();
    const restored = installSuccessfulRestore();
    const result = await lease.saveOriginalImages(args(recovery));
    expect(ports.native.restorePendingBytes).toHaveBeenCalledExactlyOnceWith({ requestId: recovery.requestId, files });
    for (let slot = 0; slot < files.length; slot += 1) expect(ports.native.restorePendingBytes.mock.calls[0][0].files[slot]).toBe(files[slot]);
    expect(ports.native.restorePendingBytes.mock.calls[0][0].files[1]).toBe(files[2]);
    expect(result).toMatchObject({ committed: true }); expect(result.snapshot).toBe(restored);
    expect(result.snapshot.localIds).toEqual([NEWER_LOCAL]);
    expect(lease.getSnapshot().recovery.state).toBe('restored'); expect(uuid).not.toHaveBeenCalled();
    assertNoTransportOrOtherMutation();
  });

  it('[O03] incomplete slots cannot call native restore or claim a commit', async () => {
    const lease = retain(), recovery = await ready(lease);
    await lease.selectOriginalImage(originalFile(B), args(recovery, 0));
    const result = await held(lease.saveOriginalImages(args(recovery)));
    expect(result.error).toBeTruthy(); expect(ports.native.restorePendingBytes).not.toHaveBeenCalled();
    expect(lease.getSnapshot().recovery.canSave).toBe(false); assertNoTransportOrOtherMutation();
  });

  it('[O04] metadata-matching wrong bytes remain a native error, not a filename-based success; explicit retry keeps the same File array', async () => {
    const lease = retain(); await ready(lease); const { recovery, files } = await selectAll(lease);
    files[1] = new File([new Uint8Array([9, 9, 9, 9])], A.name, { type: A.mimeType });
    await lease.selectOriginalImage(files[1], args(recovery, 1));
    ports.native.restorePendingBytes.mockRejectedValue(Object.assign(new Error('Native original hash mismatch'), { code: 'invalid_input' }));
    const original = ports.native.getPendingIntent(), result = await held(lease.saveOriginalImages(args(recovery)));
    expect(result.error).toMatchObject({ code: 'invalid_input' });
    expect(ports.native.restorePendingBytes).toHaveBeenCalledExactlyOnceWith({ requestId: recovery.requestId, files });
    expect(lease.getSnapshot().recovery.state).toBe('error'); expect(lease.getSnapshot().recovery.slots.every(slot => slot.selected)).toBe(true);
    expect(ports.native.getPendingIntent()).toBe(original); expect(ports.native.getSnapshot().text).toBe(NEWER_TEXT);
    window.dispatchEvent(new Event('online')); await Promise.resolve(); expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1);
    expect((await held(lease.saveOriginalImages(args(recovery)))).error).toMatchObject({ code: 'invalid_input' });
    expect(ports.native.restorePendingBytes).toHaveBeenNthCalledWith(2, { requestId: recovery.requestId, files });
    assertNoTransportOrOtherMutation();
  });

  it.each(['quota', 'conflict', 'missing_bytes'])('[O05] native %s preserves exact frozen request, newer draft and unsaved choices', async code => {
    const lease = retain(); await ready(lease); const { recovery } = await selectAll(lease);
    const before = ports.native.getSnapshot(), original = before.pending;
    ports.native.restorePendingBytes.mockRejectedValue(Object.assign(new Error(`Native ${code}`), { code }));
    const result = await held(lease.saveOriginalImages(args(recovery)));
    expect(result.error).toMatchObject({ code }); expect(ports.native.getPendingIntent()).toBe(original);
    expect(ports.native.getPendingIntent().serializedBody).toBe(original.serializedBody);
    expect(ports.native.getSnapshot()).toBe(before); expect(lease.getSnapshot().recovery.slots.every(slot => slot.selected)).toBe(true);
    await Promise.resolve(); expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1); assertNoTransportOrOtherMutation();
  });

  it('[O06] a native fulfilled result without committed:true cannot advertise restored bytes', async () => {
    const lease = retain(); await ready(lease); const { recovery } = await selectAll(lease);
    ports.native.restorePendingBytes.mockResolvedValue({ committed: false, reason: 'held', snapshot: ports.native.getSnapshot() });
    const result = await held(lease.saveOriginalImages(args(recovery)));
    expect(result.error).toBeTruthy(); expect(lease.getSnapshot().recovery.state).toBe('error');
    expect(lease.getSnapshot().recovery.slots.every(slot => slot.selected)).toBe(true); assertNoTransportOrOtherMutation();
  });

  it('[O07] shared views see choices, but releasing a view invalidates its callbacks without dropping the surviving view choices', async () => {
    const first = retain(), second = retain(); const recovery = await ready(first); await ready(second);
    await first.selectOriginalImage(originalFile(B), args(recovery, 0));
    expect(second.getSnapshot().recovery.slots[0].selected).toBe(true);
    first.release();
    const stale = await held(first.selectOriginalImage(originalFile(A), args(recovery, 1)));
    expect(stale.error).toBeTruthy(); expect(second.getSnapshot().recovery.slots[1].selected).toBe(false);
    await second.selectOriginalImage(originalFile(A), args(recovery, 1));
    expect(second.getSnapshot().recovery.slots[0].selected).toBe(true); expect(ports.native.close).not.toHaveBeenCalled();
    assertNoTransportOrOtherMutation();
  });

  it('[O08] final release/reopen drops uncommitted choices only, preserving durable original body and missing pins', async () => {
    const first = retain(); const recovery = await ready(first); const before = ports.native.getSnapshot();
    await first.selectOriginalImage(originalFile(B), args(recovery, 0)); first.release();
    expect(ports.native.close).toHaveBeenCalledTimes(1);
    const reopened = retain(); await ready(reopened);
    expect(reopened.getSnapshot().recovery.slots.every(slot => !slot.selected)).toBe(true);
    expect(ports.native.getSnapshot()).toBe(before); expect(ports.native.restorePendingBytes).not.toHaveBeenCalled();
    assertNoTransportOrOtherMutation();
  });

  it.each(['request', 'pins', 'body'])('[O09] %s ABA invalidates old selection AND old Save, even when the exact original pin array returns', async kind => {
    const lease = retain(), initial = await ready(lease), original = ports.native.getPendingIntent();
    await selectAll(lease);
    let changed;
    if (kind === 'request') {
      changed = previous({ requestId: OTHER_REQUEST, serializedBody: JSON.stringify({ ...JSON.parse(original.serializedBody), requestId: OTHER_REQUEST }) });
    } else if (kind === 'pins') {
      changed = previous({ missingBytePins: [original.missingBytePins[0], original.missingBytePins[2], original.missingBytePins[1]] });
    } else {
      changed = previous({ text: 'changed immutable body', serializedBody: JSON.stringify({ ...JSON.parse(original.serializedBody), text: 'changed immutable body' }), serializedBodySha256: 'e'.repeat(64) });
    }
    ports.native.publish(recoveredSnapshot(changed)); ports.native.publish(recoveredSnapshot(original));
    const next = lease.getSnapshot().recovery;
    expect(next.revision).toBeGreaterThan(initial.revision); expect(next.slots.every(slot => !slot.selected)).toBe(true);
    expect((await held(lease.selectOriginalImage(originalFile(B), args(initial, 0)))).error).toBeTruthy();
    expect((await held(lease.saveOriginalImages(args(initial)))).error).toBeTruthy();
    expect(ports.native.restorePendingBytes).not.toHaveBeenCalled(); assertNoTransportOrOtherMutation();
  });

  it('[O10] an unrelated newer-draft publication does not revoke selections for unchanged pending identity and pins', async () => {
    const lease = retain(), initial = await ready(lease); await selectAll(lease);
    const newerRevision = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    ports.native.publish({ ...ports.native.getSnapshot(), text: 'newer B again', headRevision: 2, revision: newerRevision, committedRevision: newerRevision });
    expect(lease.getSnapshot().storage.revision).toBe(newerRevision); expect(lease.getSnapshot().storage.committedRevision).toBe(newerRevision);
    expect(lease.getSnapshot().recovery.revision).toBe(initial.revision);
    expect(lease.getSnapshot().recovery.slots.every(slot => slot.selected)).toBe(true); assertNoTransportOrOtherMutation();
  });

  it('[O11] Save freezes one array; changes while saving cannot start another Save or report a late old commit on a replacement request', async () => {
    const lease = retain(); await ready(lease); const { recovery, files } = await selectAll(lease), gate = deferred();
    const old = ports.native.getPendingIntent(); ports.native.restorePendingBytes.mockReturnValueOnce(gate.promise);
    const saving = held(lease.saveOriginalImages(args(recovery)));
    const replacement = previous({ requestId: OTHER_REQUEST, serializedBody: JSON.stringify({ ...JSON.parse(old.serializedBody), requestId: OTHER_REQUEST }) });
    let selection, second, settledBeforeRelease, timer;
    try {
      await waitFor(() => expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1));
      selection = held(lease.selectOriginalImage(originalFile(A), args(recovery, 1)));
      second = held(lease.saveOriginalImages(args(recovery)));
      // Never await a competing action while our native completion is held.
      settledBeforeRelease = await Promise.race([Promise.all([selection, second]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
      ports.native.publish(recoveredSnapshot(replacement));
    } finally {
      clearTimeout(timer);
      // Deliberate late-port result tests consumer fencing, not native CAS.
      gate.resolve(committed(recoveredSnapshot({ ...old, missingBytePins: [] })));
    }
    expect((await selection).error).toBeTruthy(); expect((await second).error).toBeTruthy(); expect(settledBeforeRelease).toBe(true);
    expect((await saving).error).toBeTruthy();
    expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1);
    for (let slot = 0; slot < files.length; slot += 1) expect(ports.native.restorePendingBytes.mock.calls[0][0].files[slot]).toBe(files[slot]);
    expect(lease.getSnapshot().recovery.requestId).toBe(OTHER_REQUEST); expect(lease.getSnapshot().recovery.state).toBe('missing');
    expect(ports.native.getPendingIntent()).toBe(replacement); assertNoTransportOrOtherMutation();
  });

  it.each(['pins', 'body', 'disappear', 'pins_with_stale_publication'])('[O11 ABA] held restore rejects same-UUID %s ABA instead of reviving an invalidated operation', async kind => {
    const lease = retain(); await ready(lease); const { recovery, files } = await selectAll(lease), gate = deferred();
    const original = ports.native.getPendingIntent(), lateSnapshot = recoveredSnapshot({ ...original, missingBytePins: [] });
    let changed;
    if (kind === 'body') changed = previous({ text: 'different same-UUID body', serializedBodySha256: 'e'.repeat(64),
      serializedBody: JSON.stringify({ ...JSON.parse(original.serializedBody), text: 'different same-UUID body' }) });
    else if (kind === 'disappear') changed = null;
    else changed = previous({ missingBytePins: [original.missingBytePins[0], original.missingBytePins[2], original.missingBytePins[1]] });
    ports.native.restorePendingBytes.mockReturnValueOnce(gate.promise);
    const saving = held(lease.saveOriginalImages(args(recovery))); let observedAfterABA;
    try {
      await waitFor(() => expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1));
      ports.native.publish(recoveredSnapshot(changed)); ports.native.publish(recoveredSnapshot(original));
      observedAfterABA = lease.getSnapshot().recovery;
      if (kind === 'pins_with_stale_publication') {
        // Deliberate controlled stale-producer snapshot, NOT native CAS evidence.
        // A prior invalidation stays latched even if an old cleared-pin snapshot
        // and old committed result now resemble this operation's own completion.
        ports.native.publish(lateSnapshot);
      }
    } finally {
      // No competing action is awaited while this completion is held. Release
      // the only gate before every result assertion, including failure paths.
      gate.resolve(committed(lateSnapshot));
    }
    const result = await saving;
    expect(observedAfterABA?.revision).toBeGreaterThan(recovery.revision);
    expect(result.error).toBeTruthy(); expect(lease.getSnapshot().recovery?.state).not.toBe('restored');
    if (kind !== 'pins_with_stale_publication') {
      expect(lease.getSnapshot().recovery.revision).toBe(observedAfterABA.revision);
      expect(lease.getSnapshot().recovery.state).toBe('missing');
      expect(lease.getSnapshot().recovery.slots.every(slot => !slot.selected)).toBe(true);
      expect(ports.native.getPendingIntent()).toBe(original);
    }
    expect(ports.native.restorePendingBytes).toHaveBeenCalledTimes(1);
    for (let slot = 0; slot < files.length; slot += 1) expect(ports.native.restorePendingBytes.mock.calls[0][0].files[slot]).toBe(files[slot]);
    expect(ports.native.getPendingIntent().requestId).toBe(original.requestId);
    expect(ports.native.getPendingIntent().serializedBody).toBe(original.serializedBody);
    expect(ports.native.getSnapshot().text).toBe(NEWER_TEXT); expect(ports.native.getSnapshot().localIds).toEqual([NEWER_LOCAL]);
    assertNoTransportOrOtherMutation();
  });

  it.each(['text-only', 'unknown-capability'])('[O12] current model %s blocks Add/Send admission but cannot block local restoration of a valid old own/home pending', async model => {
    const lease = retain({ session: { ...SESSION, model } }), recovery = await ready(lease);
    await waitFor(() => expect(lease.getSnapshot().admission.state).toBe('blocked'));
    await selectAll(lease); installSuccessfulRestore();
    expect(await lease.saveOriginalImages(args(recovery))).toMatchObject({ committed: true }); assertNoTransportOrOtherMutation();
  });
});
