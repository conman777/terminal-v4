// UNAPPLIED additive lifecycle tests. Real hook/controller/facade with a
// controlled native pre-commit boundary, not native transaction-abort proof.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, CATALOG, SESSION, response } from '../test/userImagesJoinFixture';
import { NEWER_TEXT } from '../test/userImagesOriginalsRecoveryFixture';
import { legacyAdmissionFixture, viewArgs, outcome, assertNoOtherMutation, filesInPinOrder } from '../test/userImagesLegacyRecoveryAdmissionFixture';
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../utils/api';
import { setUser } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { useUserImageComposer } from './useUserImageComposer';

let fixture, options, unexpected;
beforeEach(() => {
  resetFixture(); fixture = legacyAdmissionFixture(); unexpected = [];
  options = { session: SESSION, active: true, store: fixture.store, sendMessage: vi.fn(), checkPendingMessage: vi.fn(), retryPendingMessage: vi.fn() };
  apiFetch.mockReset().mockImplementation(async (url, request = {}) => {
    if (url === '/api/agent/catalog' && (!request.method || request.method === 'GET') && request.body === undefined
      && Object.keys(request).every(key => ['method', 'signal'].includes(key)) && request.signal?.aborted === false) return response(CATALOG);
    unexpected.push({ url, request }); throw new Error('Unexpected HTTP in held legacy admission fixture');
  });
});
afterEach(async () => {
  await act(async () => { fixture.release(); await Promise.resolve(); });
  await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
  await cleanFixture();
});
const pending = hook => hook.result.current.userImages?.pendingPreviousSend;
async function metadata(hook) { await waitFor(() => expect(pending(hook)?.originals).toHaveLength(3)); return hook.result.current.userImages; }
function noAutomaticWork() {
  expect(unexpected).toEqual([]); expect(apiFetch.mock.calls.every(([url]) => url === '/api/agent/catalog')).toBe(true);
  expect(options.sendMessage).not.toHaveBeenCalled(); expect(options.checkPendingMessage).not.toHaveBeenCalled(); expect(options.retryPendingMessage).not.toHaveBeenCalled();
  assertNoOtherMutation(fixture, expect);
  for (const { native } of fixture.instances) expect(native.restorePendingBytes).not.toHaveBeenCalled();
}

describe('preparation owner remains writable through its native commit boundary', () => {
  it.each(['readOnly', 'inactive', 'release', 'account', 'environment'])('[LH01] %s during held preparation cannot commit or revive old actions while a readonly view survives', async kind => {
    // A surviving readonly view deliberately keeps the entry readable. Testing
    // only final unmount would let the ordinary shared-lifetime guard mask an
    // absent preparation-owner fence.
    const reader = renderHook(() => useUserImageComposer({ ...options, readOnly: true })); await metadata(reader);
    expect(fixture.entered).toEqual([]);
    const writer = renderHook(props => useUserImageComposer(props), { initialProps: options });
    const old = await metadata(writer), captured = viewArgs(old);
    try {
      await waitFor(() => expect(fixture.entered).toHaveLength(1));
      expect(pending(writer).originalsCanChoose).toBe(false); expect(pending(writer).originalsCanSave).toBe(false);
      if (kind === 'readOnly') writer.rerender({ ...options, readOnly: true });
      if (kind === 'inactive') writer.rerender({ ...options, active: false });
      if (kind === 'release') writer.unmount();
      if (kind === 'account') await act(async () => { setUser({ id: 'different-legacy-owner' }); });
      if (kind === 'environment') await act(async () => { setActiveEnvironment({ id: 'different-legacy-environment' }); });
    } finally {
      // Always release the synthetic work before any result assertion/unmount
      // cleanup, including when a required reached-call precondition fails.
      await act(async () => { fixture.release(); await Promise.resolve(); });
    }
    await waitFor(() => expect(fixture.finished).toHaveLength(fixture.entered.length));
    expect(fixture.entered).toHaveLength(1); expect(fixture.entered[0].commitGuard).toBe(false); expect(fixture.commits).toEqual([]);
    let choose, save;
    await act(async () => {
      choose = await outcome(old.selectOriginalImage(filesInPinOrder()[0], { ...captured, slot: 0 }));
      save = await outcome(old.saveOriginalImages(captured));
    });
    expect(choose.error).toBeTruthy(); expect(save.error).toBeTruthy();
    expect(pending(reader)?.originalsCanChoose ?? false).toBe(false); expect(pending(reader)?.originalsCanSave ?? false).toBe(false);
    if (kind === 'readOnly' || kind === 'inactive' || kind === 'release') {
      // Metadata remains readable; denying all readonly observation is not a
      // valid way to satisfy the write fence.
      await waitFor(() => expect(pending(reader)?.requestId).toBe(fixture.legacy.pending.requestId));
      expect(pending(reader)?.body.text).toBe(fixture.legacy.pending.text);
      expect(fixture.store.getSnapshot().text).toBe(NEWER_TEXT);
    }
    expect(localStorage.getItem(fixture.legacyKey)).toBe(fixture.legacyRaw); noAutomaticWork();
  });

  it('[LH02] readonly render loads metadata without promotion; a later writable view enables originals only after observed ready state', async () => {
    const reader = renderHook(() => useUserImageComposer({ ...options, readOnly: true })); await metadata(reader);
    expect(fixture.entered).toEqual([]); expect(fixture.instances[0].hydrateReads).toContain(true);
    expect(pending(reader).originalsCanChoose).toBe(false); expect(pending(reader).originalsCanSave).toBe(false);
    const writer = renderHook(() => useUserImageComposer(options)); await metadata(writer);
    try {
      await waitFor(() => expect(fixture.entered).toHaveLength(1));
      expect(pending(writer).originalsCanChoose).toBe(false); expect(pending(writer).originalsCanSave).toBe(false);
    } finally { await act(async () => { fixture.release(); await Promise.resolve(); }); }
    await waitFor(() => expect(pending(writer).originalsCanChoose).toBe(true));
    expect(fixture.latest().getSnapshot().storageState).toBe('ready'); expect(fixture.commits).toHaveLength(1);
    expect(pending(reader).originalsCanChoose).toBe(false); expect(pending(reader).originalsCanSave).toBe(false);
    expect(pending(writer).body.text).toBe(fixture.legacy.pending.text); noAutomaticWork();
  });
});
