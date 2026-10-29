import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

let browser, server, origin;
beforeAll(async () => {
 server = createServer((_request, response) => {response.setHeader('Connection', 'close');response.end('<!doctype html><title>Synthetic transfer cache fixture</title>');});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 origin = `http://127.0.0.1:${server.address().port}`;
 browser = await chromium.launch({ executablePath: process.env.E2E_LOCAL_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true });
});
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

it.runIf(process.env.E2E_TRANSFER_CACHE_BROWSER === '1')('partitions actual IndexedDB by home identity/environment and retires only the previous auth session', async () => {
 const context = await browser.newContext();
 try {
  const page = await context.newPage();
  await page.goto(origin);
  const sources = await Promise.all(['auth.js', 'remoteEnvironments.js', 'fileTransfers.js'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
  const browserDownload = page.waitForEvent('download');
  const result = await page.evaluate(async ([authSource, environmentSource, transferSource]) => {
   const unmodule = source => source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
   let homeOrigin = 'https://synthetic-home-one.test';
   const auth = new Function('resolveHomeApiUrl', unmodule(authSource) + ';return {setTokens,setUser,clearTokens,captureAuthScope,isAuthScopeCurrent,subscribeAuth};')(path => homeOrigin + path);
   const environment = new Function(unmodule(environmentSource) + ';return {setEnvironmentIdentity,setActiveEnvironment,getEnvironmentCacheScope:typeof getEnvironmentCacheScope === "function" ? getEnvironmentCacheScope : () => ({}),getEnvironmentSignal,subscribeEnvironment};')();
   const calls = [];
   let bytes;
   let loseAck = false;
   let receiptStarted, releaseReceipt;
   let heldReceipt;
   const fetch = async (path) => {
    calls.push(path);
    if (path.includes('download-complete')) { if (heldReceipt) { receiptStarted(); await heldReceipt; heldReceipt=null; } if (loseAck) {loseAck=false;throw new Error('Synthetic lost acknowledgment');} return { ok: true, json: async () => ({ status: 'completed' }) }; }
    return { ok: true, json: async () => ({ offset: 0, data: '41'.repeat(262144), sha256: await transfers.checksum(bytes) }) };
   };
   const transfers = new Function('apiFetch', ...Object.keys(auth), ...Object.keys(environment), unmodule(transferSource) + ';return {downloadChunks,clearDownloadCache,checksum,captureDownloadScope:typeof captureDownloadScope === "function" ? captureDownloadScope : undefined};')(fetch, ...Object.values(auth), ...Object.values(environment));
   bytes = new Uint8Array(262144).fill(65);
   const keys = () => new Promise((resolve, reject) => {
    const opening = indexedDB.open('terminal-v4-transfers');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('chunks'); const request = tx.objectStore('chunks').getAllKeys(); request.onsuccess = () => resolve(request.result); tx.oncomplete = () => db.close(); };
   });
   const pause = async id => {
    const abort = new AbortController();
    try { await transfers.downloadChunks({ id, size: bytes.length + 1 }, { signal: abort.signal, onProgress: () => abort.abort() }); } catch (error) { if (error.name !== 'AbortError') throw error; }
   };
   auth.setTokens('synthetic-access-a', 'synthetic-refresh-a'); auth.setUser({ id: 'synthetic-a' }); environment.setEnvironmentIdentity('synthetic-a');
   environment.setActiveEnvironment({ id: 'host-a' });
   await pause('same-id');
   const oldScope = transfers.captureDownloadScope?.();
   environment.setActiveEnvironment({ id: 'host-b' });
   await pause('same-id');
   const partitionCount = (await keys()).length;
   homeOrigin = 'https://synthetic-home-two.test';
   await pause('same-id');
   const homePartitionCount = (await keys()).length;
   homeOrigin = 'https://synthetic-home-one.test';
   auth.clearTokens(true); environment.setEnvironmentIdentity(null);
   auth.setTokens('synthetic-access-b', 'synthetic-refresh-b'); auth.setUser({ id: 'synthetic-b' }); environment.setEnvironmentIdentity('synthetic-b');
   await pause('same-id');
   // Retirements and explicit cleanup from an old view must not delete B's cache.
   if (oldScope) await transfers.clearDownloadCache({ id: 'same-id', size: bytes.length + 1 }, oldScope);
   const finalKeys = await keys();
   const chunkRequests = calls.filter(path => path.includes('/chunk?')).length;
   loseAck = true;
   const delivery = { id: 'lost-ack', size: bytes.length, sha256: await transfers.checksum(bytes) };
   try { await transfers.downloadChunks(delivery); throw new Error('Missing injected lost ack'); } catch (error) { if (error.message !== 'Synthetic lost acknowledgment') throw error; }
   const cachedAfterLostAck = (await keys()).length;
   const blob = await transfers.downloadChunks({ ...delivery, status: 'completed' });
   const cachedAfterRecovery = (await keys()).length;
   const anchor = document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download='synthetic-recovered.bin';anchor.click();
   const staleScope = transfers.captureDownloadScope();
   const receiptReady = new Promise(resolve => { receiptStarted=resolve; });
   heldReceipt = new Promise(resolve => { releaseReceipt=resolve; });
   const staleDelivery = transfers.downloadChunks({ ...delivery, id:'stale-delivery' }).then(()=>'delivered',error=>error.name);
   await receiptReady;
   auth.clearTokens(true);environment.setEnvironmentIdentity(null);
   auth.setTokens('synthetic-access-c','synthetic-refresh-c');auth.setUser({id:'synthetic-c'});environment.setEnvironmentIdentity('synthetic-c');
   releaseReceipt();
   const staleResult = await staleDelivery;
   await pause('stale-delivery');
   await transfers.clearDownloadCache({ ...delivery, id:'stale-delivery' }, staleScope);
   const currentKeys = await keys();
   return { partitionCount, homePartitionCount, finalKeys, chunkRequests, cachedAfterLostAck, cachedAfterRecovery, blobSize: blob.size, staleResult, currentKeys };
  }, sources);
  expect(result.partitionCount).toBe(2);
  expect(result.finalKeys).toHaveLength(1);
  expect(result.finalKeys[0]).toContain('synthetic-b');
  expect(result.homePartitionCount).toBe(3);
  expect(result.chunkRequests).toBe(4);
  expect(result.staleResult).toBe('AbortError');
  expect(result.currentKeys).toHaveLength(1);
  expect(result.currentKeys[0]).toContain('synthetic-c');
  expect([result.cachedAfterLostAck, result.cachedAfterRecovery, result.blobSize]).toEqual([2, 1, 262144]);
  const download = await browserDownload;
  expect(download.suggestedFilename()).toBe('synthetic-recovered.bin');
  const delivered = await readFile(await download.path());
  expect(delivered.equals(Buffer.alloc(262144, 65))).toBe(true);
 } finally { await context.close(); }
}, 20000);
