const DATABASE = 'terminal-v4-large-paste-recovery';
const HISTORY_PREFIX = 'tv4:large-paste-history:v1:';
const MAX_PASTE_BYTES = 25 * 1024 * 1024;
const MAX_DRAFT_BYTES = 1_000_000;
const MAX_OWNER_BYTES = 64 * 1024 * 1024;
const MAX_OWNER_RECORDS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function notifyChange() {
  try { window.dispatchEvent(new Event('tv4:large-paste-recovery-changed')); } catch { /* Another tab can refresh on focus. */ }
  try {
    if (globalThis.BroadcastChannel) {
      const channel = new BroadcastChannel('terminal-v4-large-paste-changed');
      channel.postMessage('changed');
      channel.close();
    }
  } catch { /* Another tab can refresh on focus. */ }
}

function validScope(scope) {
  if (!Array.isArray(scope) || scope.length !== 4 || scope.some(value => typeof value !== 'string' || !value || value.length > 2048)) return false;
  try { return ['http:', 'https:'].includes(new URL(scope[1]).protocol); } catch { return false; }
}

export function hasLargePasteRecoveryHistory(scope) {
  if (!validScope(scope)) return false;
  try { return localStorage.getItem(HISTORY_PREFIX + encodeURIComponent(JSON.stringify(scope))) !== null; }
  catch { return true; }
}

function recordBytes(record) {
  if (!record || record.version !== 1 || !UUID.test(record.id) || !(record.blob instanceof Blob)
    || !record.blob.type.toLowerCase().startsWith('text/plain') || record.blob.size < 1 || record.blob.size > MAX_PASTE_BYTES
    || typeof record.original !== 'string' || typeof record.prefix !== 'string' || typeof record.suffix !== 'string'
    || typeof record.revision !== 'string' || !record.revision || record.revision.length > 128
    || !['saved', 'claimed', 'uncertain'].includes(record.status)
    || (record.status === 'saved' ? record.claimId !== null : !UUID.test(record.claimId))) throw failure('corrupt', 'The saved paste could not be verified.');
  const original = encoder.encode(record.original).length, prefix = encoder.encode(record.prefix).length, suffix = encoder.encode(record.suffix).length;
  if (original > MAX_DRAFT_BYTES || prefix + suffix > MAX_DRAFT_BYTES) throw failure('corrupt', 'The saved paste draft is too large.');
  return record.blob.size + original + prefix + suffix;
}

function budgetValue(value) {
  if (value === undefined) return { version: 1, count: 0, bytes: 0 };
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_OWNER_RECORDS
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_OWNER_BYTES) throw failure('corrupt', 'The saved paste capacity could not be verified.');
  return value;
}

export function createLargePasteRecovery({ scope, isCurrent, signal, indexedDB = globalThis.indexedDB } = {}) {
  if (!validScope(scope) || typeof isCurrent !== 'function') throw failure('invalid_scope', 'An authenticated account, environment and thread are required.');
  const key = [...scope], budgetKey = scope.slice(0, 2);
  let db = null, opening = null, closed = false;
  const transactions = new Set();
  function guard() {
    if (closed || signal?.aborted || !isCurrent()) throw failure('stale_scope', 'The paste belongs to a different or closed account, environment or thread.');
  }
  async function open() {
    guard();
    if (db) return db;
    if (!indexedDB?.open) throw failure('unavailable', 'Saved paste storage is unavailable.');
    if (!opening) opening = new Promise((resolve, reject) => {
      let request, settled = false;
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      try { request = indexedDB.open(DATABASE, 1); }
      catch { fail(failure('unavailable', 'Saved paste storage is unavailable.')); return; }
      request.onupgradeneeded = () => {
        try {
          guard();
          if (!request.result.objectStoreNames.contains('pastes')) request.result.createObjectStore('pastes');
          if (!request.result.objectStoreNames.contains('budgets')) request.result.createObjectStore('budgets');
        } catch { request.transaction.abort(); }
      };
      request.onerror = () => fail(failure('unavailable', 'Saved paste storage could not be opened.'));
      request.onblocked = () => fail(failure('unavailable', 'Another tab is blocking saved paste storage.'));
      request.onsuccess = () => {
        const connection = request.result;
        try {
          guard();
          if (settled || !connection.objectStoreNames.contains('pastes') || !connection.objectStoreNames.contains('budgets')) throw failure('unavailable', 'Saved paste storage is unavailable.');
          connection.onversionchange = () => { connection.close(); if (db === connection) { db = null; opening = null; } };
          db = connection; settled = true; resolve(connection);
        } catch (error) { connection.close(); fail(error); }
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }

  async function transaction(mode, action) {
    const connection = await open(); guard();
    return new Promise((resolve, reject) => {
      let tx, problem, result, count = 0;
      try { tx = connection.transaction(['pastes', 'budgets'], mode); }
      catch { reject(failure('unavailable', 'Saved paste storage is unavailable.')); return; }
      transactions.add(tx);
      const pastes = tx.objectStore('pastes'), budgets = tx.objectStore('budgets');
      const requests = [pastes.get(key), budgets.get(budgetKey)];
      const values = [];
      const abort = error => { problem = error; try { tx.abort(); } catch { /* The transaction has already settled. */ } };
      const onScopeAbort = () => abort(failure('stale_scope', 'The paste scope changed.'));
      signal?.addEventListener('abort', onScopeAbort, { once: true });
      const timeout = setTimeout(() => abort(failure('unavailable', 'Saved paste storage timed out.')), 10000);
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', onScopeAbort); transactions.delete(tx); };
      requests.forEach((request, index) => {
        request.onsuccess = () => {
          values[index] = request.result;
          if (++count !== requests.length) return;
          try {
            guard();
            const saved = values[0] ?? null, budget = budgetValue(values[1]);
            if (saved) {
              const size = recordBytes(saved);
              if (budget.count < 1 || budget.bytes < size) throw failure('corrupt', 'The saved paste capacity could not be verified.');
            }
            result = action({ saved, budget, pastes, budgets });
          } catch (error) { abort(error); }
        };
      });
      tx.onabort = () => { cleanup(); reject(problem || failure(tx.error?.name === 'QuotaExceededError' ? 'capacity' : 'unavailable', 'The paste could not be saved on this device.')); };
      tx.onerror = () => {};
      tx.oncomplete = () => {
        cleanup();
        if (mode === 'readwrite' && result === true) notifyChange();
        try { guard(); resolve(result); } catch (error) { reject(error); }
      };
    });
  }

  return {
    async save(input) {
      guard();
      const record = { version: 1, id: input?.id, blob: input?.blob, original: input?.original, prefix: input?.prefix, suffix: input?.suffix, revision: input?.revision, status: 'saved', claimId: null };
      let bytes;
      try { bytes = recordBytes(record); } catch { throw failure('invalid_input', 'The pasted text or its saved draft is invalid or too large.'); }
      try {
        const historyKey = HISTORY_PREFIX + encodeURIComponent(JSON.stringify(key));
        localStorage.setItem(historyKey, '1');
        if (localStorage.getItem(historyKey) !== '1') throw new Error('History could not be verified');
      } catch { throw failure('unavailable', 'Saved paste recovery could not be recorded on this device.'); }
      return transaction('readwrite', ({ saved, budget, pastes, budgets }) => {
        if (saved) throw failure('exists', 'A saved paste already needs review in this thread.');
        if (budget.count >= MAX_OWNER_RECORDS || budget.bytes + bytes > MAX_OWNER_BYTES) throw failure('capacity', 'Saved paste storage is full. Review an earlier paste before continuing.');
        pastes.add(record, key);
        budgets.put({ version: 1, count: budget.count + 1, bytes: budget.bytes + bytes }, budgetKey);
        return true;
      });
    },
    async read() { return transaction('readonly', ({ saved }) => saved); },
    async clear(id) {
      guard();
      if (typeof id !== 'string' || !UUID.test(id)) throw failure('invalid_id', 'The saved paste identity is invalid.');
      return transaction('readwrite', ({ saved, budget, pastes, budgets }) => {
        if (!saved || saved.id !== id) return false;
        if (saved.status === 'claimed') throw failure('in_progress', 'The paste upload may still be running.');
        const bytes = recordBytes(saved);
        pastes.delete(key);
        budgets.put({ version: 1, count: budget.count - 1, bytes: budget.bytes - bytes }, budgetKey);
        return true;
      });
    },
    async claim(id, claimId, { reviewUncertain = false } = {}) {
      guard();
      if (!UUID.test(id) || !UUID.test(claimId)) throw failure('invalid_id', 'The saved paste identity is invalid.');
      return transaction('readwrite', ({ saved, pastes }) => {
        if (!saved || saved.id !== id) throw failure('missing', 'The saved paste is no longer available.');
        if (saved.status === 'claimed') throw failure('in_progress', 'The paste upload may still be running.');
        if (saved.status === 'uncertain' && !reviewUncertain) throw failure('needs_review', 'Review the previous upload before retrying.');
        pastes.put({ ...saved, status: 'claimed', claimId }, key);
        return true;
      });
    },
    async markUncertain(id, claimId) {
      guard();
      if (!UUID.test(id) || !UUID.test(claimId)) throw failure('invalid_id', 'The saved paste identity is invalid.');
      return transaction('readwrite', ({ saved, pastes }) => {
        if (!saved || saved.id !== id || saved.status !== 'claimed' || saved.claimId !== claimId) return false;
        pastes.put({ ...saved, status: 'uncertain' }, key);
        return true;
      });
    },
    async finish(id, claimId) {
      guard();
      if (!UUID.test(id) || !UUID.test(claimId)) throw failure('invalid_id', 'The saved paste identity is invalid.');
      return transaction('readwrite', ({ saved, budget, pastes, budgets }) => {
        if (!saved || saved.id !== id || saved.status !== 'claimed' || saved.claimId !== claimId) return false;
        const bytes = recordBytes(saved);
        pastes.delete(key);
        budgets.put({ version: 1, count: budget.count - 1, bytes: budget.bytes - bytes }, budgetKey);
        return true;
      });
    },
    close() {
      closed = true;
      for (const tx of transactions) { try { tx.abort(); } catch { /* Already completed. */ } }
      db?.close(); db = null;
    },
  };
}
