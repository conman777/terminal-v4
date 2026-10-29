// UNAPPLIED V2-only addition. Keep all V1 test/fixture bytes unchanged.
// Real hook/controller/facade; controlled native pre-commit observation only.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, CATALOG, SESSION, response } from '../test/userImagesJoinFixture';
import { NEWER_TEXT } from '../test/userImagesOriginalsRecoveryFixture';
import { legacyAdmissionFixture, viewArgs, outcome, assertNoOtherMutation, filesInPinOrder } from '../test/userImagesLegacyRecoveryAdmissionFixture';
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
    unexpected.push({ url, request }); throw new Error('Unexpected HTTP in held preparation ABA fixture');
  });
});
afterEach(async () => {
  await act(async () => { fixture.release(); await Promise.resolve(); });
  await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
  await cleanFixture();
});
const pending = hook => hook.result.current.userImages?.pendingPreviousSend;
async function metadata(hook) { await waitFor(() => expect(pending(hook)?.originals).toHaveLength(3)); return hook.result.current.userImages; }
// Read the exact original construction-time options, rather than whichever
// native/entry happens to be current after the compatible return.
const epochRetired = record => record.options.signal?.aborted === true
  || record.native.getSnapshot().storageState === 'closed' || record.options.isCurrent() === false;

describe('a compatible writer return cannot revive its prior preparation epoch', () => {
  it('[LH03] held writable→readonly→writable return leaves original epoch permanently retired; any fresh preparation is distinct and nonoverlapping', async () => {
    const reader = renderHook(() => useUserImageComposer({ ...options, readOnly: true })); await metadata(reader);
    expect(fixture.entered).toEqual([]);
    const writer = renderHook(props => useUserImageComposer(props), { initialProps: options });
    const oldView = await metadata(writer), captured = viewArgs(oldView);
    let original, retiredAtLoss, retiredAfterReturn, attemptsBeforeRelease, readableAfterReturn;
    try {
      await waitFor(() => expect(fixture.entered).toHaveLength(1));
      original = fixture.entered[0];
      writer.rerender({ ...options, readOnly: true });
      retiredAtLoss = epochRetired(original.record);
      // Complete a real hook token/lease transition back to the identical
      // session/account/environment/model while the OLD work is still held.
      writer.rerender(options);
      await waitFor(() => expect(pending(reader)?.requestId).toBe(fixture.legacy.pending.requestId));
      retiredAfterReturn = epochRetired(original.record);
      attemptsBeforeRelease = fixture.entered.slice();
      readableAfterReturn = { requestId: pending(reader)?.requestId, text: pending(reader)?.body.text, raw: fixture.store.getSnapshot().text,
        canChoose: pending(reader)?.originalsCanChoose ?? false, canSave: pending(reader)?.originalsCanSave ?? false };
    } finally {
      // Release before assertions or joins even when preparation was absent.
      await act(async () => { fixture.release(); await Promise.resolve(); });
    }
    await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
    expect(original).toBeTruthy(); expect(retiredAtLoss).toBe(true); expect(retiredAfterReturn).toBe(true);
    expect(epochRetired(original.record)).toBe(true); expect(original.commitGuard).toBe(false);
    expect(fixture.commits).not.toContain(original); expect(fixture.finished).toContain(original);
    // The old controlled operation ignores abort until its released boundary.
    // A new mutation must wait for that attempt to settle, not overlap it.
    expect(attemptsBeforeRelease).toEqual([original]); expect(fixture.peak()).toBe(1);
    const replacements = fixture.entered.filter(attempt => attempt !== original);
    for (const attempt of replacements) {
      expect(attempt.record).not.toBe(original.record); expect(attempt.record.native).not.toBe(original.record.native);
      expect(attempt.record.options).not.toBe(original.record.options);
      expect(fixture.finished.indexOf(original)).toBeLessThan(fixture.finished.indexOf(attempt));
    }
    for (const commit of fixture.commits) expect(replacements).toContain(commit);
    expect(readableAfterReturn).toEqual({ requestId: fixture.legacy.pending.requestId, text: fixture.legacy.pending.text, raw: NEWER_TEXT, canChoose: false, canSave: false });
    let staleChoose, staleSave;
    await act(async () => {
      staleChoose = await outcome(oldView.selectOriginalImage(filesInPinOrder()[0], { ...captured, slot: 0 }));
      staleSave = await outcome(oldView.saveOriginalImages(captured));
    });
    expect(staleChoose.error).toBeTruthy(); expect(staleSave.error).toBeTruthy();
    expect(pending(reader)?.originalsCanChoose ?? false).toBe(false); expect(pending(reader)?.originalsCanSave ?? false).toBe(false);
    expect(unexpected).toEqual([]); expect(apiFetch.mock.calls.every(([url]) => url === '/api/agent/catalog')).toBe(true);
    expect(options.sendMessage).not.toHaveBeenCalled(); expect(options.checkPendingMessage).not.toHaveBeenCalled(); expect(options.retryPendingMessage).not.toHaveBeenCalled();
    assertNoOtherMutation(fixture, expect);
    for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled();
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw);
  });
});
