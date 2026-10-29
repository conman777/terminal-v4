// UNAPPLIED additive regression preview against frozen108de9bc.
// Real hook/controller/facade; existing controlled native pre-commit port only.
// No IDB transaction, durability, native hash or actual HTTP proof is modeled.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, CATALOG, SESSION, response } from '../test/userImagesJoinFixture';
import { NEWER_TEXT } from '../test/userImagesOriginalsRecoveryFixture';
import { legacyAdmissionFixture, outcome, assertNoOtherMutation, filesInPinOrder } from '../test/userImagesLegacyRecoveryAdmissionFixture';
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../utils/api';
import { useUserImageComposer } from './useUserImageComposer';

let fixture, options, unexpected;
beforeEach(() => {
  resetFixture(); fixture = legacyAdmissionFixture(); unexpected = [];
  options = { session: SESSION, active: true, store: fixture.store, sendMessage: vi.fn(), checkPendingMessage: vi.fn(), retryPendingMessage: vi.fn() };
  apiFetch.mockReset().mockImplementation(async (url, request = {}) => {
    if (url === '/api/agent/catalog' && (!request.method || request.method === 'GET') && request.body === undefined
      && Object.keys(request).every(key => ['method', 'signal'].includes(key)) && request.signal?.aborted === false) return response(CATALOG);
    unexpected.push({ url, request }); throw new Error('Unexpected HTTP in legacy preparation waiter regression');
  });
});
afterEach(async () => {
  // The synthetic gate ignores AbortSignal until explicitly released. Release
  // before waiting or React cleanup, including failed reached-call assertions.
  await act(async () => { fixture.release(); await Promise.resolve(); });
  await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
  await cleanFixture();
});
const pending = hook => hook.result.current.userImages?.pendingPreviousSend;
async function metadata(hook) {
  await waitFor(() => expect(pending(hook)?.originals).toHaveLength(3));
  return hook.result.current.userImages;
}
const epochRetired = record => record.options.signal?.aborted === true
  || record.native.getSnapshot().storageState === 'closed' || record.options.isCurrent() === false;
function noMutationOrHTTP() {
  expect(unexpected).toEqual([]);
  expect(apiFetch.mock.calls.every(([url]) => url === '/api/agent/catalog')).toBe(true);
  expect(options.sendMessage).not.toHaveBeenCalled();
  expect(options.checkPendingMessage).not.toHaveBeenCalled();
  expect(options.retryPendingMessage).not.toHaveBeenCalled();
  assertNoOtherMutation(fixture, expect);
  for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled();
}

describe('an admitted Add waiter cannot inherit another native recovery epoch', () => {
  it('[LW01] writer readonly loss retires its held admission and waiting Add cannot promote the surviving readonly context', async () => {
    const reader = renderHook(() => useUserImageComposer({ ...options, readOnly: true })); await metadata(reader);
    expect(fixture.entered).toEqual([]);
    const writer = renderHook(props => useUserImageComposer(props), { initialProps: options });
    await metadata(writer);
    let waiting, settled = false, original, retiredAtLoss, rebound;
    try {
      await waitFor(() => expect(fixture.entered).toHaveLength(1));
      await waitFor(() => expect(writer.result.current.userImages.admission.state).toBe('allowed'));
      original = fixture.entered[0];
      const oldAdd = writer.result.current.userImages.addFiles;
      await act(async () => {
        waiting = outcome(oldAdd([filesInPinOrder()[0]])).then(result => { settled = true; return result; });
        await Promise.resolve();
      });
      // Fixture metadata has isSaving=false; the real shared controller's
      // isAdding publication is the positive reached-wait precondition here.
      await waitFor(() => expect(writer.result.current.userImages.isSaving).toBe(true));
      expect(settled).toBe(false); expect(fixture.entered).toHaveLength(1);
      for (const { native } of fixture.instances) expect(native.addFiles).not.toHaveBeenCalled();

      writer.rerender({ ...options, readOnly: true });
      retiredAtLoss = epochRetired(original.record);
      await waitFor(() => expect(fixture.instances.length).toBeGreaterThan(1));
      rebound = fixture.instances.at(-1);
      await waitFor(() => expect(rebound.hydrateReads).toContain(true));
      expect(rebound.native.getSnapshot().storageState).toBe('legacy');
      expect(pending(reader)?.requestId).toBe(fixture.legacy.pending.requestId);
      expect(pending(reader)?.originalsCanChoose).toBe(false);
    } finally {
      await act(async () => { fixture.release(); await Promise.resolve(); });
    }
    let result;
    if (waiting) await act(async () => { result = await waiting; });
    await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));

    expect(original).toBeTruthy(); expect(retiredAtLoss).toBe(true);
    expect(epochRetired(original.record)).toBe(true); expect(original.commitGuard).toBe(false);
    expect(rebound).not.toBe(original.record); expect(rebound.options).not.toBe(original.record.options);
    // A new readonly constructor is valid for metadata; it is not authority for
    // the old Add to start a second native promotion after its writer retired.
    expect(fixture.entered).toEqual([original]); expect(fixture.commits).toEqual([]);
    expect(result?.error).toBeTruthy(); noMutationOrHTTP();
    expect(pending(reader)?.requestId).toBe(fixture.legacy.pending.requestId);
    expect(pending(reader)?.body.text).toBe(fixture.legacy.pending.text);
    expect(fixture.store.getSnapshot().text).toBe(NEWER_TEXT);
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw);
  });

  it('[LW02] a queued Add observes genuine failed admission rather than silently calling promotion again', async () => {
    fixture.failure = 'quota';
    const writer = renderHook(() => useUserImageComposer(options)); await metadata(writer);
    let waiting, settled = false, original;
    try {
      await waitFor(() => expect(fixture.entered).toHaveLength(1));
      await waitFor(() => expect(writer.result.current.userImages.admission.state).toBe('allowed'));
      original = fixture.entered[0];
      await act(async () => {
        waiting = outcome(writer.result.current.userImages.addFiles([filesInPinOrder()[0]])).then(result => { settled = true; return result; });
        await Promise.resolve();
      });
      await waitFor(() => expect(writer.result.current.userImages.isSaving).toBe(true));
      expect(settled).toBe(false); expect(fixture.entered).toHaveLength(1);
      for (const { native } of fixture.instances) expect(native.addFiles).not.toHaveBeenCalled();
    } finally {
      await act(async () => { fixture.release(); await Promise.resolve(); });
    }
    let result;
    if (waiting) await act(async () => { result = await waiting; });
    await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));

    expect(original?.commitGuard).toBe(true); // Owner stayed current; this is a genuine quota failure.
    expect(fixture.entered).toEqual([original]); expect(fixture.commits).toEqual([]);
    expect(result?.error).toBeTruthy(); noMutationOrHTTP();
    expect(pending(writer)?.originalsCanChoose).toBe(false); expect(pending(writer)?.originalsCanSave).toBe(false);
    expect(pending(writer)?.requestId).toBe(fixture.legacy.pending.requestId);
    expect(fixture.store.getSnapshot().text).toBe(NEWER_TEXT);
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw);
  });
});
