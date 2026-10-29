// UNAPPLIED additive tests. Actual shared controller/facade; controlled native
// guard/publications only. No observed RED, native durability or runtime claim.
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, controllerOptions, CATALOG, SESSION, response } from '../test/userImagesJoinFixture';
import { NEWER_TEXT } from '../test/userImagesOriginalsRecoveryFixture';
import { legacyAdmissionFixture, recoveryArgs, outcome, assertNoOtherMutation, filesInPinOrder } from '../test/userImagesLegacyRecoveryAdmissionFixture';
vi.mock('./userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';
import { retainUserImageComposer } from './userImageComposerController';

let fixture, leases, unexpected;
beforeEach(() => {
  resetFixture(); leases = []; unexpected = [];
  apiFetch.mockReset().mockImplementation(async (url, options = {}) => {
    if (url === '/api/agent/catalog' && (!options.method || options.method === 'GET') && options.body === undefined
      && Object.keys(options).every(key => ['method', 'signal'].includes(key)) && options.signal?.aborted === false) return response(CATALOG);
    unexpected.push({ url, options }); throw new Error('Unexpected HTTP during local legacy recovery admission');
  });
});
afterEach(async () => {
  fixture?.release();
  for (const lease of leases) lease.release();
  if (fixture) await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
  await cleanFixture(); fixture = null;
});
function retain(overrides = {}) { const lease = retainUserImageComposer(controllerOptions({ store: fixture.store, ...overrides })); leases.push(lease); return lease; }
async function metadata(lease) { await waitFor(() => expect(lease.getSnapshot().recovery?.slots).toHaveLength(3)); return lease.getSnapshot().recovery; }
async function preparationEntered() { await waitFor(() => expect(fixture.entered).toHaveLength(1)); }
function noTransport() { expect(unexpected).toEqual([]); expect(apiFetch.mock.calls.every(([url]) => url === '/api/agent/catalog')).toBe(true); assertNoOtherMutation(fixture, expect); }
function pendingKept(lease) {
  expect(lease.getSnapshot().storage.pending.serializedBody).toBe(fixture.legacy.pending.serializedBody);
  expect(lease.getSnapshot().storage.pending.requestId).toBe(fixture.legacy.pending.requestId);
  expect(lease.getSnapshot().storage.text).toBe(NEWER_TEXT);
}

describe('writable-owned legacy recovery admission before original-byte actions', () => {
  it('[LA01] held preparation keeps visible pins non-actionable and direct choose/Save cannot reach native restore', async () => {
    fixture = legacyAdmissionFixture(); const lease = retain(), before = await metadata(lease);
    try {
      await preparationEntered();
      expect(lease.getSnapshot().storage.storageState).toBe('legacy');
      expect(lease.getSnapshot().recovery.canChoose).toBe(false); expect(lease.getSnapshot().recovery.canSave).toBe(false);
      const choose = await outcome(lease.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(before, 0)));
      const save = await outcome(lease.saveOriginalImages(recoveryArgs(before)));
      expect(choose.error).toBeTruthy(); expect(save.error).toBeTruthy();
      expect(lease.getSnapshot().recovery.slots.every(slot => !slot.selected)).toBe(true);
      for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled();
      expect(fixture.commits).toEqual([]); pendingKept(lease); noTransport();
    } finally { fixture.release(); }
  });

  it('[LA02] successful preparation may replace authority/pin IDs; old revision retires and current exact original order can commit', async () => {
    fixture = legacyAdmissionFixture(); const lease = retain(), before = await metadata(lease);
    try { await preparationEntered(); } finally { fixture.release(); }
    await waitFor(() => expect(lease.getSnapshot().storage.storageState).toBe('ready'));
    const prepared = lease.getSnapshot(), recovery = prepared.recovery;
    expect(fixture.commits).toHaveLength(1); expect(fixture.peak()).toBe(1);
    expect(prepared.storage.authorityId).toBe(fixture.ready.authorityId); expect(prepared.storage.authorityId).not.toBe(fixture.legacy.authorityId);
    expect(prepared.storage.pending.missingBytePins).toEqual(fixture.ready.pending.missingBytePins);
    expect(prepared.storage.pending.missingBytePins).not.toEqual(fixture.legacy.pending.missingBytePins);
    expect(recovery.revision).toBeGreaterThan(before.revision); expect(recovery.canChoose).toBe(true);
    expect((await outcome(lease.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(before, 0)))).error).toBeTruthy();
    expect((await outcome(lease.saveOriginalImages(recoveryArgs(before)))).error).toBeTruthy();
    pendingKept(lease); const files = filesInPinOrder(), count = fixture.entered.length;
    for (let slot = 0; slot < files.length; slot += 1) await lease.selectOriginalImage(files[slot], recoveryArgs(recovery, slot));
    expect(lease.getSnapshot().recovery.canSave).toBe(true);
    const result = await lease.saveOriginalImages(recoveryArgs(recovery)), native = fixture.latest();
    expect(result.committed).toBe(true); expect(lease.getSnapshot().recovery.state).toBe('restored');
    expect(native.restorePendingBytes).toHaveBeenCalledExactlyOnceWith({ requestId: recovery.requestId, files });
    const passed = native.restorePendingBytes.mock.calls[0][0].files;
    expect(Object.isFrozen(passed)).toBe(true); for (let i = 0; i < files.length; i += 1) expect(passed[i]).toBe(files[i]);
    expect(passed[0]).toBe(passed[2]); expect(fixture.entered).toHaveLength(count); pendingKept(lease); noTransport();
  });

  it.each(['quota', 'conflict'])('[LA03] preparation %s retains legacy source/body/newer raw, disables recovery and never dispatches or settles', async code => {
    fixture = legacyAdmissionFixture(); fixture.failure = code; const lease = retain(); await metadata(lease);
    try { await preparationEntered(); } finally { fixture.release(); }
    await waitFor(() => expect(fixture.finished).toHaveLength(1));
    await waitFor(() => expect(lease.getSnapshot().error || lease.getSnapshot().storage.error?.message).toBeTruthy());
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw); expect(fixture.commits).toEqual([]);
    const recovery = lease.getSnapshot().recovery;
    expect(recovery.canChoose).toBe(false); expect(recovery.canSave).toBe(false);
    expect((await outcome(lease.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(recovery, 0)))).error).toBeTruthy();
    expect((await outcome(lease.saveOriginalImages(recoveryArgs(recovery)))).error).toBeTruthy();
    window.dispatchEvent(new Event('online')); await Promise.resolve(); expect(fixture.entered).toHaveLength(1);
    for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled();
    pendingKept(lease); noTransport();
  });

  it('[LA04] initial readonly hydration stays readable with no preparation, false action flags and no direct mutation', async () => {
    fixture = legacyAdmissionFixture(); const lease = retain({ readOnly: true }), recovery = await metadata(lease);
    expect(fixture.instances[0].hydrateReads).toContain(true); expect(lease.getSnapshot().storage.storageState).toBe('legacy');
    expect(fixture.entered).toEqual([]); expect(recovery.canChoose).toBe(false); expect(recovery.canSave).toBe(false);
    expect((await outcome(lease.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(recovery, 0)))).error).toBeTruthy();
    expect((await outcome(lease.saveOriginalImages(recoveryArgs(recovery)))).error).toBeTruthy();
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw); pendingKept(lease); noTransport();
  });

  it('[LA05] readonly-first plus duplicate writable views has one preparation; readonly remains unable to restore', async () => {
    fixture = legacyAdmissionFixture(); const reader = retain({ readOnly: true }); await metadata(reader);
    expect(fixture.entered).toEqual([]);
    const writer = retain(); await metadata(writer);
    try {
      await preparationEntered(); const duplicate = retain(); await metadata(duplicate); expect(fixture.peak()).toBe(1);
      const recovery = reader.getSnapshot().recovery;
      expect((await outcome(reader.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(recovery, 0)))).error).toBeTruthy();
      duplicate.release(); expect(fixture.entered).toHaveLength(1);
    } finally { fixture.release(); }
    await waitFor(() => expect(writer.getSnapshot().storage.storageState).toBe('ready'));
    expect(fixture.commits).toHaveLength(1); expect(fixture.entered).toHaveLength(1);
    expect(writer.getSnapshot().recovery.canChoose).toBe(true); pendingKept(writer); noTransport();
  });

  it.each(['text-only', 'unknown-capability'])('[LA06] blocked model %s still permits local metadata preparation and original-byte recovery', async model => {
    fixture = legacyAdmissionFixture(); const lease = retain({ session: { ...SESSION, model } }); await metadata(lease);
    try { await preparationEntered(); } finally { fixture.release(); }
    await waitFor(() => expect(lease.getSnapshot().admission.state).toBe('blocked'));
    await waitFor(() => expect(lease.getSnapshot().storage.storageState).toBe('ready'));
    const recovery = lease.getSnapshot().recovery, files = filesInPinOrder();
    expect(recovery.canChoose).toBe(true);
    for (let slot = 0; slot < files.length; slot += 1) await lease.selectOriginalImage(files[slot], recoveryArgs(recovery, slot));
    expect((await lease.saveOriginalImages(recoveryArgs(recovery))).committed).toBe(true);
    expect(fixture.entered).toHaveLength(1); expect(fixture.commits).toHaveLength(1); pendingKept(lease); noTransport();
  });

  it('[LA07] a fulfilled non-ready preparation result cannot authorize choose or Save', async () => {
    fixture = legacyAdmissionFixture(); fixture.resolveNonReady = true; const lease = retain(); await metadata(lease);
    try { await preparationEntered(); } finally { fixture.release(); }
    await waitFor(() => expect(fixture.finished).toHaveLength(1));
    const recovery = lease.getSnapshot().recovery;
    expect(lease.getSnapshot().storage.storageState).toBe('legacy'); expect(recovery.canChoose).toBe(false); expect(recovery.canSave).toBe(false);
    expect((await outcome(lease.selectOriginalImage(filesInPinOrder()[0], recoveryArgs(recovery, 0)))).error).toBeTruthy();
    expect((await outcome(lease.saveOriginalImages(recoveryArgs(recovery)))).error).toBeTruthy();
    expect(fixture.commits).toEqual([]); for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled(); noTransport();
  });

  it('[LA08] already-ready metadata with no missing pins does not start recovery admission', async () => {
    fixture = legacyAdmissionFixture({ readyInitially: true, noMissingPins: true }); const lease = retain();
    await waitFor(() => expect(lease.getSnapshot().storage?.storageState).toBe('ready'));
    expect(lease.getSnapshot().recovery).toBeNull(); expect(fixture.entered).toEqual([]); expect(fixture.commits).toEqual([]); noTransport();
  });
});
