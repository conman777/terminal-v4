import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intent, ports, resetFixture, cleanFixture, controllerOptions, snapshot, file, A, L1, L2, R1, R2, SESSION, CATALOG, deferred, response } from '../test/userImagesJoinFixture';
vi.mock('./userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from './api';
import { getComposerDraftStore } from './composerDraftStore';
import { retainUserImageComposer } from './userImageComposerController';

let leases;
beforeEach(() => {
  resetFixture(); leases = [];
  const empty = snapshot({ storageState: 'ready', localIds: [], items: [] });
  const local = snapshot({ items: [{ ...snapshot().items[0], uploadState: 'local', descriptor: null }] });
  ports.native.publish({ ...empty, storageState: 'legacy' });
  ports.native.promoteLegacy.mockImplementation(async () => { ports.native.publish(empty); return empty; });
  ports.native.addFiles.mockImplementation(async () => { ports.native.publish(local); return { committed: true, headRevision: 1, revision: R1, snapshot: local }; });
  ports.native.completeUpload.mockImplementation(async () => { const ready = snapshot(); ports.native.publish(ready); return { applied: true, snapshot: ready }; });
  apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201));
});
afterEach(async () => { for (const lease of leases) lease.release(); await cleanFixture(); });
const retain = overrides => { const lease = retainUserImageComposer(controllerOptions(overrides)); leases.push(lease); return lease; };
const settle = async operation => { try { await operation; } catch { /* Assertions below observe the missing new behavior, not setup errors. */ } };
const allow = lease => waitFor(() => expect(lease.getSnapshot().admission.state).toBe('allowed'));
const imageHTTP = () => apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'));

describe('real stable facade and one owned image controller', () => {
  it('[F01] preserves the exact shared synchronous legacy text store without constructing native storage', () => {
    const store = getComposerDraftStore(SESSION.id), methods = [store.getSnapshot, store.subscribe, store.setText, store.prepareIntent, store.confirmIntent];
    store.setText('plain text'); const pending = store.prepareIntent('plain text');
    expect(pending).not.toBeInstanceOf(Promise);
    expect(pending).toMatchObject({ text: 'plain text', draftRevision: store.getSnapshot().revision });
    expect(getComposerDraftStore(SESSION.id)).toBe(store);
    expect([store.getSnapshot, store.subscribe, store.setText, store.prepareIntent, store.confirmIntent]).toEqual(methods);
    expect(ports.nativeFactory).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('[F02] promotes in place so already captured facade references share native text, methods and send lease', async () => {
    const store = getComposerDraftStore(SESSION.id), other = getComposerDraftStore(SESSION.id);
    const methods = [store.getSnapshot, store.subscribe, store.setText, store.prepareIntent, store.confirmIntent];
    const lease = retain({ store }); await allow(lease); await settle(lease.addFiles([file()], { source: 'picker' }));
    expect(ports.nativeFactory).toHaveBeenCalledTimes(1);
    expect(ports.native.promoteLegacy).toHaveBeenCalledTimes(1);
    ports.native.publish(snapshot({ text: 'published native raw' }));
    expect(store).toBe(other); expect(other.getSnapshot().text).toBe('published native raw');
    expect([store.getSnapshot, store.subscribe, store.setText, store.prepareIntent, store.confirmIntent]).toEqual(methods);
    const sendLease = store.claimSend(); expect(sendLease).toBeTruthy(); expect(other.claimSend()).toBeNull(); store.releaseSend(sendLease);
  });

  it('[F03] a malformed promotion marker never seeds an empty writable legacy fallback', async () => {
    const store = getComposerDraftStore(SESSION.id); store.setText('preserve dirty raw');
    const key = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id));
    expect(key).toBeTruthy(); const malformed = '{"version":2,"kind":"v4-image-promotion","scope":["foreign"]}';
    localStorage.setItem(key, malformed);
    ports.native.hydrate.mockRejectedValue(Object.assign(new Error('Corrupt promotion'), { code: 'corrupt' }));
    const lease = retain({ store }); await waitFor(() => expect(ports.nativeFactory).toHaveBeenCalledTimes(1));
    expect(ports.nativeFactory).toHaveBeenCalledTimes(1);
    expect(ports.native.hydrate).toHaveBeenCalledTimes(1);
    expect(lease.getSnapshot().storage?.storageState).not.toBe('ready');
    expect(localStorage.getItem(key)).toBe(malformed);
    expect(imageHTTP()).toEqual([]);
  });

  it('[F04] captures old submitted revision and IDs before flush without relabeling them to a newer draft', async () => {
    const store = getComposerDraftStore(SESSION.id), lease = retain({ store });
    await allow(lease); await settle(lease.addFiles([file()], { source: 'drop' }));
    const gate = deferred(); ports.native.flush.mockReturnValueOnce(gate.promise);
    const sending = Promise.resolve(store.prepareIntent('old canonical', [A], { draftRevision: R1, localIds: [L1] }));
    ports.native.publish(snapshot({ text: 'new raw B', revision: R2, committedRevision: R2, localIds: [L2] }));
    gate.resolve({ committed: true, headRevision: 2, revision: R1, snapshot: ports.native.getSnapshot() }); await settle(sending);
    expect(ports.native.prepareIntent).toHaveBeenCalledWith({ text: 'old canonical', attachments: [A], draftRevision: R1, localIds: [L1] });
    expect(store.getSnapshot()).toMatchObject({ text: 'new raw B', revision: R2 });
  });

  it.each([['gpt-5.4', 'allowed'], ['text-only', 'blocked'], ['unknown-capability', 'blocked'], ['custom-unknown', 'blocked']])('[C01] resolves canonical model %s capability, never provider default', async (model, state) => {
    const lease = retain({ session: { ...SESSION, model } });
    await waitFor(() => expect(lease.getSnapshot().admission.state).toBe(state));
    if (state !== 'allowed') await expect(lease.addFiles([file()], { source: 'picker' })).rejects.toThrow();
    expect(imageHTTP()).toEqual([]);
  });

  it('[C02] commits Add and upload UUID before HTTP, then awaits durable ready adoption', async () => {
    const add = deferred(), begin = deferred(), complete = deferred();
    ports.native.addFiles.mockReturnValueOnce(add.promise); ports.native.beginUpload.mockReturnValueOnce(begin.promise); ports.native.completeUpload.mockReturnValueOnce(complete.promise);
    const lease = retain(); await allow(lease); const adding = lease.addFiles([file()], { source: 'paste' }); adding.catch(() => {});
    let settled = false; adding.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => expect(ports.native.addFiles).toHaveBeenCalled()); expect(imageHTTP()).toEqual([]);
    const committedAdd = snapshot({ items: [{ ...snapshot().items[0], uploadState: 'local', descriptor: null }] });
    ports.native.publish(committedAdd); add.resolve({ committed: true, headRevision: 1, revision: R1, snapshot: committedAdd }); await waitFor(() => expect(ports.native.beginUpload).toHaveBeenCalledWith(L1));
    expect(imageHTTP()).toEqual([]);
    const ticket = { ...(await ports.native.getBlob(L1)), scopeKey: ports.native.getSnapshot().scopeKey, authorityId: R2, uploadGeneration: 1 };
    begin.resolve(ticket); await waitFor(() => expect(imageHTTP()).toHaveLength(1));
    expect(ports.native.beginUpload).toHaveBeenCalledWith(L1);
    expect(imageHTTP()).toHaveLength(1);
    const [, options] = imageHTTP()[0]; expect(options.body).toBeInstanceOf(FormData);
    expect([...options.body.keys()]).toEqual(['uploadId', 'image']); expect(options.body.get('uploadId')).toBe(A.attachmentId);
    expect(options.body.get('image').name).toBe(A.name); expect(options.body.get('image').type).toBe(A.mimeType);
    expect(options.headers?.['Content-Type']).toBeUndefined();
    await waitFor(() => expect(ports.native.completeUpload).toHaveBeenCalled()); expect(settled).toBe(false);
    complete.resolve({ applied: true, snapshot: ports.native.getSnapshot() }); await settle(adding); expect(settled).toBe(true);
    expect(ports.native.completeUpload).toHaveBeenCalledWith(ticket, { status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 });
  });

  it('[C03] shares one job across two views; only final release aborts and closes without deleting bytes', async () => {
    const upload = deferred(); apiFetch.mockImplementation(url => url === '/api/agent/catalog' ? Promise.resolve(response(CATALOG)) : upload.promise);
    const first = retain(), second = retain(); await allow(first); const unsubscribe = first.subscribe(() => {});
    const adding = first.addFiles([file()], { source: 'picker' }); adding.catch(() => {});
    await waitFor(() => expect(imageHTTP()).toHaveLength(1));
    expect(ports.nativeFactory).toHaveBeenCalledTimes(1); expect(imageHTTP()).toHaveLength(1);
    const signal = imageHTTP()[0][1].signal; unsubscribe(); first.release();
    expect(signal.aborted).toBe(false); expect(ports.native.close).not.toHaveBeenCalled();
    second.release(); expect(signal.aborted).toBe(true); expect(ports.native.close).toHaveBeenCalledTimes(1);
    upload.resolve(response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201)); await settle(adding);
    expect(ports.native.completeUpload).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    apiFetch.mockClear(); retain(); await Promise.resolve();
    expect(imageHTTP()).toEqual([]); expect(apiFetch.mock.calls.some(([url]) => url.includes('/requests/'))).toBe(false);
  });

  it('[C03 remaining view] releasing the initiating view still permits adoption for the other live view', async () => {
    const upload = deferred(); apiFetch.mockImplementation(url => url === '/api/agent/catalog' ? Promise.resolve(response(CATALOG)) : upload.promise);
    let firstCurrent = true; const first = retain({ isCurrent: () => firstCurrent }), second = retain(); await allow(first);
    const adding = first.addFiles([file()], { source: 'picker' }); adding.catch(() => {});
    await waitFor(() => expect(imageHTTP()).toHaveLength(1)); firstCurrent = false; first.release();
    expect(ports.nativeFactory.mock.calls[0][0].isCurrent()).toBe(true);
    expect(ports.native.close).not.toHaveBeenCalled(); expect(imageHTTP()[0][1].signal.aborted).toBe(false);
    upload.resolve(response({ status: 'ready', attachment: A, expiresAt: 4_000_000_000_000 }, 201)); await settle(adding);
    expect(ports.native.completeUpload).toHaveBeenCalledTimes(1);
    expect(second.getSnapshot().storage.items[0]).toMatchObject({ descriptor: A, uploadState: 'ready' });
    second.release(); expect(ports.native.close).toHaveBeenCalledTimes(1);
  });

  it('[C04] commits a removal job before DELETE and local completion', async () => {
    const native = ports.native, removal = deferred(), http = deferred();
    native.removeImage.mockReturnValueOnce(removal.promise);
    apiFetch.mockImplementation(url => url === '/api/agent/catalog' ? Promise.resolve(response(CATALOG)) : http.promise);
    const lease = retain(); const removing = lease.removeImage(L1); removing.catch(() => {});
    await waitFor(() => expect(native.removeImage).toHaveBeenCalled()); expect(imageHTTP()).toEqual([]);
    native.publish(snapshot({ localIds: [], items: [], removals: [{ uploadId: A.attachmentId, uploadGeneration: 1, localId: L1 }] }));
    removal.resolve({ committed: true, headRevision: 2, revision: R2, snapshot: native.getSnapshot() }); await waitFor(() => expect(imageHTTP()).toHaveLength(1));
    expect(imageHTTP()).toHaveLength(1); expect(imageHTTP()[0][1].method).toBe('DELETE');
    expect(imageHTTP()[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/attachments/${A.attachmentId}`);
    expect(native.completeRemoval).not.toHaveBeenCalled(); http.resolve(response(null, 204)); await settle(removing);
    expect(native.completeRemoval).toHaveBeenCalledWith({ uploadId: A.attachmentId, uploadGeneration: 1 });
  });

  it('[C04 pins] a native pending-pinned unlink produces no remote cancellation', async () => {
    const original = intent(), pinned = snapshot({ pending: original, localIds: [], items: [], removals: [] });
    ports.native.publish(snapshot({ pending: original }));
    ports.native.removeImage.mockImplementation(async () => { ports.native.publish(pinned); return { committed: true, headRevision: 2, revision: R2, snapshot: pinned }; });
    const lease = retain(); await expect(lease.removeImage(L1)).resolves.toMatchObject({ committed: true });
    expect(ports.native.getSnapshot().pending).toBe(original); expect(imageHTTP()).toEqual([]);
    expect(ports.native.completeRemoval).not.toHaveBeenCalled();
  });

  it('[C04 retry job] reloaded removal is locally held, then explicit Retry uses the stored job without unlinking twice', async () => {
    const store = getComposerDraftStore(SESSION.id); store.setText('keep removal state');
    const key = Object.keys(localStorage).find(key => key.includes('composerDraft:v1:') && key.endsWith(SESSION.id)); expect(key).toBeTruthy();
    const recovered = snapshot({ localIds: [], items: [], removals: [{ uploadId: A.attachmentId, uploadGeneration: 1, localId: L1 }] });
    ports.native.publish(recovered);
    localStorage.setItem(key, JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: JSON.parse(recovered.scopeKey), authorityId: R2, legacySourceSha256: 'd'.repeat(64) }));
    apiFetch.mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(null, 204));
    const lease = retain({ store }); await waitFor(() => expect(ports.native.hydrate).toHaveBeenCalled());
    expect(imageHTTP()).toEqual([]); await lease.removeImage(L1);
    expect(ports.native.removeImage).not.toHaveBeenCalled(); expect(imageHTTP()).toHaveLength(1);
    expect(imageHTTP()[0][0]).toBe(`/api/structured/sessions/${SESSION.id}/attachments/${A.attachmentId}`);
    expect(ports.native.completeRemoval).toHaveBeenCalledWith({ uploadId: A.attachmentId, uploadGeneration: 1 });
  });

  it('[C04 local_only] unsaved retained source removal reports no durable commit and performs no DELETE', async () => {
    const local = { committed: false, reason: 'local_only', snapshot: snapshot({ localIds: [], items: [] }) };
    ports.native.removeImage.mockResolvedValueOnce(local);
    const lease = retain(); await expect(lease.removeImage(L1)).resolves.toEqual(local);
    expect(imageHTTP()).toEqual([]); expect(ports.native.completeRemoval).not.toHaveBeenCalled();
  });
});
