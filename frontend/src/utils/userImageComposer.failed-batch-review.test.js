// UNAPPLIED: real controller/facade; explicit authored native port snapshots.
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, controllerOptions, snapshot, file, A, B, L1, L2, CATALOG, response } from '../test/userImagesJoinFixture';
vi.mock('./userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';
import { retainUserImageComposer } from './userImageComposerController';
let lease;
beforeEach(() => { resetFixture(); apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response({ status: 'ready', attachment: B, expiresAt: 4_000_000_000_000 }, 201)); });
afterEach(async () => { lease?.release(); await cleanFixture(); });
describe('shared retained unsaved Add sources', () => {
  it('removing one failed local-only image does not reintroduce it when retrying the remaining exact File', async () => {
    const first = file(), second = new File([new Uint8Array([5, 6, 7, 8])], B.name, { type: B.mimeType });
    const empty = snapshot({ localIds: [], items: [] }); ports.native.publish(empty);
    const failed = snapshot({ localIds: [], items: [
      { ...snapshot().items[0], descriptor: null, durability: 'missing', uploadState: 'local' },
      { ...snapshot().items[0], localId: L2, name: B.name, uploadId: B.attachmentId, descriptor: null, durability: 'missing', uploadState: 'local' },
    ] });
    ports.native.addFiles.mockImplementationOnce(async () => { ports.native.publish(failed); throw Object.assign(new Error('Synthetic native Add quota failure'), { code: 'quota' }); });
    lease = retainUserImageComposer(controllerOptions()); await waitFor(() => expect(lease.getSnapshot().admission.state).toBe('allowed'));
    await expect(lease.addFiles([first, second])).rejects.toThrow(/quota/);
    const remaining = { ...failed, items: [failed.items[1]] };
    ports.native.removeImage.mockImplementationOnce(async () => { ports.native.publish(remaining); return { committed: false, reason: 'local_only', snapshot: remaining }; });
    await expect(lease.removeImage(L1)).resolves.toMatchObject({ committed: false, reason: 'local_only' });
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toEqual([]);
    const local = snapshot({ localIds: [L2], items: [{ ...remaining.items[0], durability: 'saved' }] });
    ports.native.addFiles.mockImplementationOnce(async () => { ports.native.publish(local); return { committed: true, snapshot: local }; });
    const ticket = { ...(await ports.native.getBlob(L1)), localId: L2, uploadId: B.attachmentId, artifactId: B.artifactId, name: B.name, blob: second, uploadGeneration: 1 };
    ports.native.beginUpload.mockResolvedValueOnce(ticket); ports.native.completeUpload.mockResolvedValueOnce({ applied: true, snapshot: local });
    await lease.retryUpload(L2).catch(() => {});
    expect(ports.native.addFiles.mock.calls[1][0]).toEqual([second]);
    expect(ports.native.addFiles.mock.calls[1][0][0]).toBe(second); expect(ports.native.beginUpload).toHaveBeenCalledWith(L2);
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toHaveLength(1);
  });
});
