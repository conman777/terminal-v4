import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from './auth';
import { getEnvironmentCacheScope, getEnvironmentSignal } from './remoteEnvironments';
import { apiFetch } from './api';
import { sha256Hex } from './sha256';
export const TRANSFER_CHUNK_BYTES = 262144;
export async function transferRequest(path, options = {}) {
 const response = await apiFetch('/api/transfers' + path, options);
 const body = await response.json();
 if (!response.ok) throw new Error(body.error || 'File transfer failed');
 return body;
}
export function bytesToHex(bytes) { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
export function hexToBytes(hex) { if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Invalid transfer bytes'); return Uint8Array.from(hex.match(/../g) || [], value => parseInt(value, 16)); }
export async function checksum(bytes) { return sha256Hex(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)); }
export async function uploadChunks(transfer, file, { signal, onProgress = () => {} } = {}) {
 let current = await transferRequest('/' + transfer.id, { signal });
 if (file.size !== current.size) throw new Error('Select the original file with the same size');
 if (current.status === 'completed') return current;
 // Recheck the prefix so a same-size replacement cannot corrupt a resumed upload.
 for (let offset = 0; offset < current.offset; offset += TRANSFER_CHUNK_BYTES) {
  signal?.throwIfAborted();
  const end = Math.min(current.offset, offset + TRANSFER_CHUNK_BYTES);
  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  await transferRequest('/' + transfer.id + '/chunk', { method: 'PUT', signal, body: { offset, data: bytesToHex(bytes), sha256: await checksum(bytes) } });
 }
 while (current.offset < current.size) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.slice(current.offset, current.offset + TRANSFER_CHUNK_BYTES).arrayBuffer());
  const previous = current.offset;
  current = await transferRequest('/' + transfer.id + '/chunk', { method: 'PUT', signal, body: { offset: previous, data: bytesToHex(bytes), sha256: await checksum(bytes) } });
  if (current.offset <= previous || current.offset > current.size) throw new Error('Invalid upload progress');
  onProgress(current);
 }
 signal?.throwIfAborted();
 return transferRequest('/' + transfer.id + '/complete', { method: 'POST', signal });
}
export function captureDownloadScope() {
 return { auth: captureAuthScope(), ...getEnvironmentCacheScope(), signal: getEnvironmentSignal() };
}
function assertDownloadScope(scope, signal) {
 signal?.throwIfAborted();
 scope.signal.throwIfAborted();
 if (!isAuthScopeCurrent(scope.auth) || captureAuthScope().userId !== scope.auth.userId || scope.identity !== getEnvironmentCacheScope().identity) throw new DOMException('Download identity changed', 'AbortError');
}
function cacheRequest(scope, transferId, mode, offset, chunk) {
 if (!globalThis.indexedDB || (!scope.auth.userId && mode !== 'retire')) return Promise.resolve(undefined);
 return new Promise((resolve, reject) => {
  const opening = indexedDB.open('terminal-v4-transfers', 2);
  opening.onupgradeneeded = () => {
   const db = opening.result;
   if (db.objectStoreNames.contains('chunks')) db.deleteObjectStore('chunks');
   db.createObjectStore('chunks');
  };
  opening.onerror = () => reject(opening.error);
  opening.onsuccess = () => {
   const db = opening.result;
   const tx = db.transaction('chunks', mode === 'get' ? 'readonly' : 'readwrite');
   const store = tx.objectStore('chunks');
   let result;
   tx.oncomplete = () => { db.close();resolve(result); };
   tx.onerror = tx.onabort = () => { db.close();reject(tx.error || new Error('Download cache transaction aborted')); };
   const auth = scope.auth;
   if (mode === 'retire') {
    if (!isAuthScopeCurrent(scope.auth) || captureAuthScope().userId !== scope.auth.userId) { tx.abort();return; }
    const request = store.openCursor();
    request.onsuccess = () => {
     const cursor = request.result;
     if (!cursor) return;
     let key;try { key = JSON.parse(cursor.key); } catch { key = null; }
     if (!Array.isArray(key) || (key[1] !== auth.userId || key[2] !== auth.session)) cursor.delete();
     cursor.continue();
    };
    return;
   }
   if (mode !== 'delete') {
    try { assertDownloadScope(scope); } catch { tx.abort();return; }
   }
   const key = JSON.stringify([auth.home, auth.userId, auth.session, scope.identity, scope.environment, transferId, offset]);
   const request = mode === 'put' ? store.put(chunk, key) : mode === 'delete' ? store.delete(key) : store.get(key);
   request.onsuccess = () => { result = request.result; };
  };
 });
}
// Transactions from retired views use their captured key, never the current identity.
cacheRequest(captureDownloadScope(), '', 'retire').catch(() => {});
subscribeAuth(() => {
 const scope = captureDownloadScope();
 cacheRequest(scope, '', 'retire').catch(() => {});
});
export async function clearDownloadCache(transfer, scope = captureDownloadScope()) {
 for (let offset = 0; offset < transfer.size; offset += TRANSFER_CHUNK_BYTES) await cacheRequest(scope, transfer.id, 'delete', offset).catch(() => {});
}
export async function downloadChunks(transfer, { signal, onProgress = () => {} } = {}) {
 const scope = captureDownloadScope();
 assertDownloadScope(scope, signal);
 await cacheRequest(scope, '', 'retire').catch(() => {});
 let offset = 0;
 const parts = [];
 while (offset < transfer.size) {
  assertDownloadScope(scope, signal);
  const cached = await cacheRequest(scope, transfer.id, 'get', offset).catch(() => undefined);
  const chunk = cached || await transferRequest('/' + transfer.id + '/chunk?' + new URLSearchParams({ offset, length: TRANSFER_CHUNK_BYTES }), { signal });
  const bytes = hexToBytes(chunk.data);
  if (chunk.offset !== offset || !bytes.length || bytes.length > TRANSFER_CHUNK_BYTES || offset + bytes.length > transfer.size) throw new Error('Invalid download progress');
  if (await checksum(bytes) !== chunk.sha256) throw new Error('Download checksum mismatch');
  assertDownloadScope(scope, signal);
  if (!cached) await cacheRequest(scope, transfer.id, 'put', offset, chunk).catch(() => {});
  parts.push(bytes);
  offset += bytes.length;onProgress({ ...transfer, offset });
 }
 const blob = new Blob(parts);
 const sha256 = await checksum(await blob.arrayBuffer());
 if (transfer.sha256 && sha256 !== transfer.sha256) throw new Error('File checksum mismatch');
 assertDownloadScope(scope, signal);
 await transferRequest('/' + transfer.id + '/download-complete', { method: 'POST', signal, body: { sha256 } });
 assertDownloadScope(scope, signal);
 await clearDownloadCache(transfer, scope);
 assertDownloadScope(scope, signal);
 return blob;
}
