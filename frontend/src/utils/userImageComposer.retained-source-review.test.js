// UNAPPLIED consumer tests: real controller/facade and three authored native
// snapshots. No native quota, hashing, IDB, persistence or upload proof.
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, controllerOptions, snapshot, A, L1, R2, CATALOG, response } from '../test/userImagesJoinFixture';
vi.mock('./userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';
import { retainUserImageComposer } from './userImageComposerController';
let lease;
beforeEach(() => { resetFixture(); apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG)
  : response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201)); });
afterEach(async () => { lease?.release(); await cleanFixture(); });

describe('failed Add source identity survives a rejected replacement batch', () => {
  it.each([
    ['different metadata', 'replacement.webp', 'image/webp'],
    ['same name/type/size but different bytes', A.name, A.mimeType],
  ])('retries exact original A after attempted B with %s', async (label, name, mimeType) => {
    const originalFile = new File([new Uint8Array([1, 2, 3, 4])], A.name, { type: A.mimeType });
    const replacement = new File([new Uint8Array([9, 8, 7, 6])], name, { type: mimeType });
    expect(replacement).not.toBe(originalFile);
    if (label.startsWith('same')) expect([replacement.name, replacement.type, replacement.size]).toEqual([originalFile.name, originalFile.type, originalFile.size]);
    const empty = snapshot({ localIds: [], items: [] });
    const failed = snapshot({ localIds: [], items: [{ ...snapshot().items[0], durability: 'missing', uploadState: 'local', descriptor: null }] });
    const local = snapshot({ items: [{ ...snapshot().items[0], uploadState: 'local', descriptor: null }] });
    const ready = snapshot(); ports.native.publish(empty);
    let originalAttemptFailed = false;
    ports.native.addFiles.mockImplementation(async files => {
      // This native port rejects every non-original object, preserving the
      // original authored failed snapshot. A future controller may reject B
      // before calling this port; no call-index assumption is required.
      if (files.length !== 1 || files[0] !== originalFile) throw Object.assign(new Error('Retry or remove the original unsaved batch'), { code: 'not_ready' });
      if (!originalAttemptFailed) {
        originalAttemptFailed = true; ports.native.publish(failed);
        throw Object.assign(new Error('Synthetic original Add quota failure'), { code: 'quota' });
      }
      ports.native.publish(local); return { committed: true, snapshot: local };
    });
    const ticket = { blob: originalFile, localId: L1, uploadId: A.attachmentId, artifactId: A.artifactId,
      mimeType: A.mimeType, bytes: A.bytes, name: A.name, rawSha256: 'd'.repeat(64), scopeKey: local.scopeKey, authorityId: R2, uploadGeneration: 1 };
    ports.native.beginUpload.mockImplementation(async localId => {
      expect(localId).toBe(L1); expect(ports.native.getSnapshot()).toBe(local);
      return ticket;
    });
    ports.native.completeUpload.mockImplementation(async (received, receipt) => {
      expect(received).toBe(ticket); expect(receipt.attachment).toEqual(A);
      ports.native.publish(ready); return { applied: true, snapshot: ready };
    });
    lease = retainUserImageComposer(controllerOptions()); await waitFor(() => expect(lease.getSnapshot().admission.state).toBe('allowed'));
    await expect(lease.addFiles([originalFile])).rejects.toThrow(/quota/);
    expect(ports.native.getSnapshot()).toBe(failed);
    await expect(lease.addFiles([replacement])).rejects.toThrow();
    expect(ports.native.getSnapshot()).toBe(failed); expect(ports.native.getSnapshot().items[0].uploadId).toBe(A.attachmentId);
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toEqual([]);
    const retry = await lease.retryUpload(L1).catch(error => ({ error }));
    expect(retry).toMatchObject({ committed: true });
    const originalCalls = ports.native.addFiles.mock.calls.filter(([files]) => files.length === 1 && files[0] === originalFile);
    expect(originalCalls).toHaveLength(2); expect(originalCalls[1][0][0]).toBe(originalFile);
    expect(ports.native.beginUpload).toHaveBeenCalledExactlyOnceWith(L1);
    expect(ports.native.completeUpload).toHaveBeenCalledExactlyOnceWith(ticket, { status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 });
    const uploads = apiFetch.mock.calls.filter(([url]) => url.endsWith('/attachments'));
    expect(uploads).toHaveLength(1); expect(uploads[0][1].method).toBe('POST');
    expect(uploads[0][1].body.get('uploadId')).toBe(A.attachmentId);
    expect(ports.native.getSnapshot()).toBe(ready); expect(ports.native.getSnapshot().items[0].descriptor).toEqual(A);
    expect(ports.native.prepareIntent).not.toHaveBeenCalled(); expect(ports.native.confirmIntent).not.toHaveBeenCalled();
    expect(ports.native.removeImage).not.toHaveBeenCalled(); expect(ports.native.completeRemoval).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.some(([url, options]) => url.endsWith('/attachments/send') || url.endsWith('/input') || options?.method === 'DELETE')).toBe(false);
  });
});
