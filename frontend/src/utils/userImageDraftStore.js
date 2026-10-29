import { createUuid } from './createUuid';
import { cloneImageAttachments, sameImageInput } from './userImageInput';
import { sha256Hex } from './sha256';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STATUSES = new Set(['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'cleanup_required', 'reconciliation_required']);
const LIMIT = { image: 8388608, message: 16777216, count: 8, bytes: 67108864, rows: 256, scopes: 128, head: 4194304, legacy: 1000000 };
const enc = new TextEncoder();
const bytes = value => enc.encode(value).byteLength;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safe = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function requireValue(test, code = 'corrupt', message = 'Saved image draft could not be verified. Its request identity was kept.') {
  if (!test) throw failure(code, message);
}
function dense(value, test, max = LIMIT.count, unique = false) {
  return Array.isArray(value) && value.length <= max
    && Object.keys(value).length === value.length
    && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) && test(value[i])).every(Boolean)
    && (!unique || new Set(value).size === value.length);
}
function validScope(scope) {
  if (!dense(scope, item => typeof item === 'string' && item.length > 0 && item.length <= 2048 && !/[\u0000-\u001f\u007f-\u009f]/.test(item), 4) || scope.length !== 4) return false;
  try {
    const home = new URL(scope[1]);
    return ['http:', 'https:'].includes(home.protocol) && !home.username && !home.password && !home.search && !home.hash
      && home.href === scope[1] && home.pathname.endsWith('/') && (scope[2] === 'home' || /^paired:[^\s]+$/.test(scope[2]));
  } catch { return false; }
}
function ids(value, max = LIMIT.count) { return dense(value, item => typeof item === 'string' && UUID.test(item), max, true); }
function descriptor(value) { return cloneImageAttachments([value])[0]; }
function receiptMatches(receipt, pending) {
  return plain(receipt) && receipt.requestId === pending.requestId && STATUSES.has(receipt.status)
    && typeof receipt.turnId === 'string' && receipt.turnId.length > 0 && receipt.turnId.length <= 256
    && typeof receipt.messageId === 'string' && receipt.messageId.length > 0 && receipt.messageId.length <= 256
    && Number.isSafeInteger(receipt.acceptedSeq) && receipt.acceptedSeq > 0
    && (pending.kind !== 'images-v1' || sameImageInput(receipt.input, { text: pending.text, attachments: pending.attachments }));
}
function sameReceiptIdentity(left, right, pending) {
  return receiptMatches(left, pending) && receiptMatches(right, pending)
    && ['requestId', 'turnId', 'messageId', 'acceptedSeq'].every(field => left[field] === right[field]);
}
function receiptProof(receipt, pending) {
  return { status: receipt.status, requestId: receipt.requestId, turnId: receipt.turnId,
    messageId: receipt.messageId, acceptedSeq: receipt.acceptedSeq,
    ...(pending.kind === 'images-v1' ? { input: { text: pending.text, attachments: clone(pending.attachments) } } : {}) };
}
function validatePending(value) {
  requireValue(keys(value, ['kind', 'requestId', 'text', 'draftRevision', 'submittedLocalIds', 'missingBytePins', 'serializedBody', 'serializedBodySha256', 'rawSourceEvidence', 'acceptedReceipt'], ['attachments']));
  requireValue(['legacy-text-v1', 'images-v1'].includes(value.kind) && UUID.test(value.requestId) && UUID.test(value.draftRevision)
    && typeof value.text === 'string' && typeof value.serializedBody === 'string' && bytes(value.serializedBody) <= LIMIT.head
    && typeof value.serializedBodySha256 === 'string' && HASH.test(value.serializedBodySha256) && ids(value.submittedLocalIds));
  const image = value.kind === 'images-v1';
  if (image) {
    try { cloneImageAttachments(value.attachments); } catch { throw failure('corrupt', 'Saved image references could not be verified.'); }
    requireValue(value.submittedLocalIds.length === value.attachments.length);
  } else requireValue(!Object.hasOwn(value, 'attachments') && value.submittedLocalIds.length === 0);
  let body;
  try { body = JSON.parse(value.serializedBody); } catch { throw failure('corrupt', 'Saved request body is unreadable. Its identity was kept.'); }
  requireValue(image
    ? keys(body, ['requestId', 'text', 'attachments']) && body.requestId === value.requestId && sameImageInput({ text: body.text, attachments: body.attachments }, { text: value.text, attachments: value.attachments })
    : keys(body, ['requestId', 'text', 'fallbackToMessage']) && body.requestId === value.requestId && body.text === `${value.text}\n` && body.fallbackToMessage === true);
  requireValue(dense(value.missingBytePins, pin => keys(pin, ['localId', 'attachment']) && UUID.test(pin.localId)));
  const seen = new Set();
  for (const pin of value.missingBytePins) {
    const index = value.submittedLocalIds.indexOf(pin.localId);
    requireValue(image && index >= 0 && !seen.has(pin.localId)); seen.add(pin.localId);
    try { requireValue(equal(descriptor(pin.attachment), value.attachments[index])); } catch { throw failure('corrupt', 'Saved missing-image identity is invalid.'); }
  }
  const source = value.rawSourceEvidence;
  requireValue(source?.kind === 'draft'
    ? keys(source, ['kind', 'revision', 'localIds']) && source.revision === value.draftRevision && ids(source.localIds) && equal(source.localIds, value.submittedLocalIds)
    : keys(source, ['kind']) && source.kind === 'legacy_image_unknown' && image);
  requireValue(value.acceptedReceipt === null || receiptMatches(value.acceptedReceipt, value));
}
function markerFor(head) {
  return JSON.stringify({ version: 2, kind: 'v4-image-promotion', scope: head.scope, authorityId: head.authorityId, legacySourceSha256: head.migration.legacySourceSha256 });
}
function decodeMarker(raw, scope) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  return keys(value, ['version', 'kind', 'scope', 'authorityId', 'legacySourceSha256']) && value.version === 2 && value.kind === 'v4-image-promotion'
    && equal(value.scope, scope) && UUID.test(value.authorityId) && (value.legacySourceSha256 === null || HASH.test(value.legacySourceSha256)) ? value : null;
}

/** Validates metadata and body semantics only; native bytes are checked separately. */
export function decodeUserImageDraftHead(value, scope) {
  requireValue(validScope(scope));
  requireValue(keys(value, ['schemaVersion', 'scope', 'authorityId', 'headRevision', 'draft', 'pending', 'removals', 'migration'])
    && value.schemaVersion === 1 && equal(value.scope, scope) && UUID.test(value.authorityId) && safe(value.headRevision));
  requireValue(keys(value.draft, ['revision', 'rawText', 'localIds']) && UUID.test(value.draft.revision)
    && typeof value.draft.rawText === 'string' && ids(value.draft.localIds));
  if (value.pending !== null) validatePending(value.pending);
  requireValue(dense(value.removals, job => keys(job, ['uploadId', 'uploadGeneration', 'localId'])
    && UUID.test(job.uploadId) && UUID.test(job.localId) && safe(job.uploadGeneration) && job.uploadGeneration > 0, LIMIT.rows));
  requireValue(new Set(value.removals.map(job => job.uploadId)).size === value.removals.length
    && value.removals.every(job => !value.pending?.submittedLocalIds.includes(job.localId)));
  const migration = value.migration;
  requireValue(keys(migration, ['state', 'legacyRaw', 'legacySourceSha256', 'expectedMarker', 'observedConflict'])
    && ['copy_committed', 'ready', 'conflict'].includes(migration.state)
    && (migration.legacyRaw === null || (typeof migration.legacyRaw === 'string' && bytes(migration.legacyRaw) <= LIMIT.legacy))
    && (migration.legacyRaw === null ? migration.legacySourceSha256 === null : typeof migration.legacySourceSha256 === 'string' && HASH.test(migration.legacySourceSha256))
    && (migration.observedConflict === null || typeof migration.observedConflict === 'string' && bytes(migration.observedConflict) <= LIMIT.legacy));
  requireValue(migration.expectedMarker === null || typeof migration.expectedMarker === 'string' && migration.expectedMarker.length < 8192
    && decodeMarker(migration.expectedMarker, scope)?.authorityId === value.authorityId
    && migration.expectedMarker === markerFor(value));
  requireValue(migration.state !== 'ready' || migration.expectedMarker !== null);
  requireValue(bytes(JSON.stringify(value)) <= LIMIT.head);
  return freeze(clone(value));
}

async function sha(data) {
  return sha256Hex(typeof data === 'string' ? enc.encode(data) : new Uint8Array(data));
}
async function imageData(file, localId = createUuid(), uploadId = createUuid()) {
  requireValue(file instanceof Blob && TYPES.has(file.type) && file.size > 0 && file.size <= LIMIT.image,
    'invalid_input', 'Choose a PNG, JPEG, GIF or WebP image no larger than 8 MiB.');
  const name = typeof file.name === 'string' ? file.name : 'image.png';
  // Reuse the wire validator for filename, MIME and byte limits.
  try { descriptor({ attachmentId: uploadId, artifactId: '0'.repeat(64), mimeType: file.type, bytes: file.size, name }); }
  catch { throw failure('invalid_input', 'The image filename or metadata is invalid.'); }
  const data = new Uint8Array(await file.arrayBuffer()), prefix = enc.encode(`v4-image-v1\0${file.type}\0`);
  const typed = new Uint8Array(prefix.length + data.length); typed.set(prefix); typed.set(data, prefix.length);
  return { localId, uploadId, blob: file, mimeType: file.type, bytes: data.length, name,
    rawSha256: await sha(data), artifactId: await sha(typed), uploadGeneration: 0, uploadState: 'local', readyDescriptor: null, expiresAt: null, errorCode: null };
}
function validateRow(row, key) {
  requireValue(keys(row, ['localId', 'uploadId', 'blob', 'mimeType', 'bytes', 'name', 'rawSha256', 'artifactId', 'uploadGeneration', 'uploadState', 'readyDescriptor', 'expiresAt', 'errorCode'])
    && UUID.test(row.localId) && UUID.test(row.uploadId) && Array.isArray(key) && key.length === 5 && validScope(key.slice(0, 4)) && row.localId === key[4]
    && row.blob instanceof Blob && row.blob.size === row.bytes && row.blob.type === row.mimeType && HASH.test(row.rawSha256) && HASH.test(row.artifactId)
    && safe(row.uploadGeneration) && ['local', 'uploading', 'ready', 'failed', 'unknown', 'removing'].includes(row.uploadState)
    && (row.expiresAt === null || safe(row.expiresAt) && row.expiresAt > 0)
    && (row.errorCode === null || typeof row.errorCode === 'string' && row.errorCode.length <= 80));
  try {
    descriptor({ attachmentId: row.uploadId, artifactId: row.artifactId, mimeType: row.mimeType, bytes: row.bytes, name: row.name });
    if (row.readyDescriptor !== null) requireValue(equal(descriptor(row.readyDescriptor), { ...row.readyDescriptor })
      && row.readyDescriptor.attachmentId === row.uploadId
      && row.readyDescriptor.artifactId === row.artifactId && row.readyDescriptor.mimeType === row.mimeType && row.readyDescriptor.bytes === row.bytes && row.readyDescriptor.name === row.name);
  } catch { throw failure('corrupt', 'Saved image metadata is invalid.'); }
  requireValue(row.uploadState !== 'ready' || row.readyDescriptor !== null && row.expiresAt !== null);
}
function rowCopy(row) { return { ...row, readyDescriptor: row.readyDescriptor ? clone(row.readyDescriptor) : null }; }
function normalizeError(error) {
  if (error?.code && typeof error.code === 'string') return error;
  return failure(error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable', 'The image draft could not be saved or read on this device. Your source was kept.');
}

export function createUserImageDraftStore(options = {}) {
  const scope = Array.isArray(options.scope) ? [...options.scope] : options.scope;
  requireValue(validScope(scope), 'invalid_scope', 'An authenticated owner, full home URL, environment and conversation are required.');
  const factory = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
  const KeyRange = Object.hasOwn(options, 'IDBKeyRange') ? options.IDBKeyRange : globalThis.IDBKeyRange;
  const legacy = options.legacy;
  requireValue(legacy && typeof legacy.readRaw === 'function' && typeof legacy.writeMarker === 'function', 'invalid_input', 'A scoped legacy storage adapter is required.');
  const name = options.databaseName || 'v4-composer-images';
  requireValue(typeof name === 'string' && name.length > 0 && name.length <= 256, 'invalid_input');
  const initial = options.initialDraft;
  requireValue(!initial || typeof initial.text === 'string' && UUID.test(initial.revision), 'invalid_input');
  const scopeKey = JSON.stringify(scope), headKey = ['scope', ...scope], budgetKey = ['budget', scope[0], scope[1]];
  let displayed = { text: initial?.text || '', revision: initial?.revision || createUuid(), localIds: [] };
  let dirty = Boolean(initial), head = null, rows = new Map(), baseRevision = null, state = 'legacy', hydrated = false;
  let error = null, conflict = null, snapshot, hydrating = false, saving = 0, closed = false, queue = Promise.resolve(), opening = null, db = null;
  let legacyRaw, captured = false, channel = null, scopeDigest = null, expiryTimer = null;
  const listeners = new Set(), transactions = new Set(), issuedTickets = new WeakSet(), failedAdds = new Map();
  const quietBlobReadFailures = new WeakSet();
  function current() { return !closed && !options.signal?.aborted && (!options.isCurrent || options.isCurrent()); }
  function guard() {
    if (closed) throw failure('closed', 'This draft view is closed. Its saved source was kept.');
    requireValue(current(), 'stale_scope', 'The account, home or conversation changed. Its saved source was kept.');
    requireValue(scope[2] === 'home', 'invalid_scope', 'Image drafts require your home server.');
  }
  function item(row, durable = true) {
    const expired = row.uploadState === 'ready' && row.expiresAt <= Date.now();
    return { localId: row.localId, name: row.name, mimeType: row.mimeType, bytes: row.bytes, durability: durable ? 'saved' : 'missing',
      uploadState: expired ? 'expired' : row.uploadState === 'uploading' && issuedTicketIds.get(row.localId) !== row.uploadGeneration ? 'unknown' : row.uploadState,
      uploadId: row.uploadId, uploadGeneration: row.uploadGeneration, expiresAt: row.expiresAt,
      descriptor: row.readyDescriptor ? clone(row.readyDescriptor) : null, errorCode: durable ? expired ? 'upload_expired' : row.errorCode : error?.code || 'unavailable' };
  }
  const issuedTicketIds = new Map();
  function publish() {
    clearTimeout(expiryTimer); expiryTimer = null;
    if (current()) {
      const now = Date.now();
      const deadlines = displayed.localIds.map(id => rows.get(id)).filter(row => row?.uploadState === 'ready' && row.expiresAt > now).map(row => row.expiresAt);
      if (deadlines.length) expiryTimer = setTimeout(publish, Math.min(Math.min(...deadlines) - now, 2147483647));
    }
    const items = displayed.localIds.map(id => {
      if (rows.has(id)) return item(rows.get(id));
      const index = head?.pending?.submittedLocalIds.indexOf(id) ?? -1;
      const attachment = index >= 0 ? head.pending.attachments?.[index] : null;
      return { localId: id, name: attachment?.name || 'Unavailable image', mimeType: attachment?.mimeType || '', bytes: attachment?.bytes || 0,
        durability: 'missing', uploadState: 'failed', uploadId: null, uploadGeneration: 0, descriptor: attachment ? clone(attachment) : null, errorCode: 'missing_bytes' };
    });
    for (const row of failedAdds.values()) items.push(item(row, false));
    snapshot = freeze({ scopeKey, storageState: closed ? 'closed' : state, authorityId: head?.authorityId || null, headRevision: head?.headRevision ?? null,
      text: displayed.text, revision: displayed.revision, committedRevision: head?.draft.revision || null, localIds: [...displayed.localIds], items,
      pending: head?.pending ? clone(head.pending) : null, removals: head ? clone(head.removals) : [], isHydrating: hydrating, isSaving: saving > 0,
      error: error ? { code: error.code, message: error.message.slice(0, 400) } : null, conflict: conflict ? clone(conflict) : null,
      migration: head ? clone(head.migration) : null });
    for (const listener of listeners) listener();
  }
  function adopt(next, nextRows, submittedRevision) {
    head = next ? clone(next) : null; rows = nextRows || new Map();
    if (head) {
      if (!dirty || displayed.revision === submittedRevision) {
        displayed = { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] }; dirty = false;
      } else displayed = { ...displayed, localIds: [...head.draft.localIds] };
      baseRevision = head.draft.revision; state = head.migration.state;
    }
    error = null; conflict = null;
    if (head?.migration.state === 'conflict') {
      error = failure('conflict', 'The original and promoted drafts need review. Both sources were kept.');
      conflict = { savedDraft: { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] }, localDraft: { ...displayed },
        legacyRawSnapshots: [head.migration.legacyRaw, head.migration.observedConflict].filter(value => typeof value === 'string') };
    }
    publish();
  }
  function remember(caught) {
    const problem = normalizeError(caught);
    if (current()) {
      error = problem;
      if (problem.savedHead && problem.code !== 'conflict') {
        head = clone(problem.savedHead); rows = problem.savedRows || rows;
        if (!dirty) displayed = { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] };
      }
      if (problem.code === 'conflict') {
        if (problem.savedHead) { head = clone(problem.savedHead); rows = problem.savedRows || rows; }
        conflict = { savedDraft: head ? { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] } : { text: '', revision: '', localIds: [] },
          localDraft: { ...displayed, localIds: [...displayed.localIds] }, legacyRawSnapshots: [head?.migration.legacyRaw, problem.observedRaw].filter(value => typeof value === 'string').slice(0, 2) };
        state = 'conflict';
      } else if (problem.code === 'unavailable' || problem.code === 'corrupt') state = 'unavailable';
      publish();
    }
    return problem;
  }
  function enqueue(task, write = true) {
    const run = queue.then(async () => {
      guard(); if (write) { saving += 1; publish(); }
      let outcome;
      try { outcome = await task(); } catch (caught) {
        if (write && caught.code === 'conflict' && Object.hasOwn(caught, 'observedRaw') && current()) {
          // Retain an observed legacy divergence in the authoritative head. This
          // does not pretend that the two storage systems committed atomically.
          try {
            const retained = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
              if (!saved) return { changed: false };
              const next = clone(saved); next.migration.state = 'conflict';
              next.migration.observedConflict = typeof caught.observedRaw === 'string' && bytes(caught.observedRaw) <= LIMIT.legacy ? caught.observedRaw : null;
              return { head: next, rows: new Map(scopedRows) };
            });
            if (retained.head) { caught.savedHead = retained.head; caught.savedRows = retained.rows; }
          } catch { /* Keep both original storage locations and the held local error if retaining evidence also fails. */ }
        }
        throw quietBlobReadFailures.has(caught) ? caught : remember(caught);
      }
      finally { if (write) { saving -= 1; publish(); } }
      if (outcome && Object.hasOwn(outcome, 'snapshot')) return { ...outcome, snapshot };
      if (outcome?.scopeKey === scopeKey && Object.hasOwn(outcome, 'storageState')) return snapshot;
      return outcome;
    });
    queue = run.catch(() => {}); return run;
  }
  function available() { requireValue(factory && typeof factory.open === 'function' && KeyRange, 'unavailable', 'IndexedDB is unavailable. Your raw draft was kept.'); }
  async function open() {
    guard(); available();
    if (db) return db;
    if (!opening) opening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = caught => { if (!settled) { settled = true; reject(normalizeError(caught)); } };
      let request;
      try { request = factory.open(name, 1); } catch (caught) { fail(caught); return; }
      request.onupgradeneeded = () => {
        if (!current()) { request.transaction.abort(); return; }
        for (const store of ['records', 'blobs']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(failure('unavailable', 'Another view is blocking image storage. Close that view and retry.'));
      request.onsuccess = () => {
        const result = request.result;
        if (settled || !current()) { result.close(); fail(failure(closed ? 'closed' : 'stale_scope', 'The draft scope changed.')); return; }
        if (!result.objectStoreNames.contains('records') || !result.objectStoreNames.contains('blobs')) { result.close(); fail(failure('corrupt', 'The image database schema is unavailable.')); return; }
        result.onversionchange = () => { result.close(); if (db === result) { db = null; opening = null; } };
        db = result; settled = true; resolve(result);
      };
    }).catch(caught => { opening = null; throw caught; });
    return opening;
  }
  function range(prefix) { return KeyRange.bound(prefix, [...prefix, []]); }
  function readLegacy() {
    guard(); const raw = legacy.readRaw();
    requireValue(raw === null || typeof raw === 'string' && bytes(raw) <= LIMIT.head, 'corrupt', 'The original saved draft is unreadable.');
    return raw;
  }
  function checkMarker(value) {
    if (!value || value.migration.state !== 'ready') return;
    const actual = readLegacy();
    if (actual !== value.migration.expectedMarker) {
      const problem = failure('conflict', 'A different legacy draft was observed. Both drafts were kept.'); problem.observedRaw = actual; throw problem;
    }
  }
  function staleDraft(saved, scopedRows) {
    const problem = failure('conflict', 'A newer saved draft or request was found. Your local draft was kept.');
    problem.savedHead = saved; problem.savedRows = scopedRows; return problem;
  }
  async function data(mode, change) {
    const connection = await open(); guard();
    return new Promise((resolve, reject) => {
      let transaction, problem, result, count = 0;
      try { transaction = connection.transaction(['records', 'blobs'], mode); } catch (caught) { reject(normalizeError(caught)); return; }
      transactions.add(transaction);
      const records = transaction.objectStore('records'), blobs = transaction.objectStore('blobs'), values = {};
      const requests = {
        head: records.get(headKey), budget: records.get(budgetKey),
        allRows: blobs.getAll(range([scope[0], scope[1]])), allKeys: blobs.getAllKeys(range([scope[0], scope[1]])),
        scopes: records.count(range(['scope', scope[0], scope[1]])),
      };
      function abort(caught) { problem = caught; try { transaction.abort(); } catch { /* Already finished; completion still checks the scope. */ } }
      for (const [key, request] of Object.entries(requests)) request.onsuccess = () => {
        values[key] = request.result; count += 1;
        if (count !== Object.keys(requests).length) return;
        let savedForError = null, rowsForError = null;
        try {
          guard();
          const saved = values.head === undefined ? null : clone(decodeUserImageDraftHead(values.head, scope));
          const scopedRows = new Map(); let totalBytes = 0;
          savedForError = saved; rowsForError = scopedRows;
          requireValue(values.allRows.length === values.allKeys.length && values.allRows.length <= LIMIT.rows && values.scopes <= LIMIT.scopes);
          values.allRows.forEach((row, i) => {
            const key = values.allKeys[i]; validateRow(row, key); totalBytes += row.bytes;
            if (equal(key.slice(0, 4), scope)) scopedRows.set(row.localId, rowCopy(row));
          });
          requireValue(totalBytes <= LIMIT.bytes);
          const expected = { schemaVersion: 1, bytes: totalBytes, blobRows: values.allRows.length, scopes: values.scopes };
          if (values.budget === undefined) requireValue(totalBytes === 0 && values.scopes === 0);
          else requireValue(keys(values.budget, ['schemaVersion', 'bytes', 'blobRows', 'scopes'])
            && Object.keys(expected).every(key => values.budget[key] === expected[key]));
          if (mode === 'readonly') { result = { head: saved, rows: scopedRows }; return; }
          const mutation = change({ head: saved, rows: scopedRows });
          if (!mutation || mutation.changed === false) { result = { head: saved, rows: scopedRows, value: mutation?.value }; return; }
          const next = mutation.head, nextRows = mutation.rows || scopedRows;
          requireValue(next && next.authorityId === (saved?.authorityId || next.authorityId));
          next.headRevision = (saved?.headRevision || 0) + 1; requireValue(safe(next.headRevision));
          decodeUserImageDraftHead(next, scope);
          const budget = { schemaVersion: 1, bytes: totalBytes - [...scopedRows.values()].reduce((sum, row) => sum + row.bytes, 0) + [...nextRows.values()].reduce((sum, row) => sum + row.bytes, 0),
            blobRows: values.allRows.length - scopedRows.size + nextRows.size, scopes: values.scopes + (saved ? 0 : 1) };
          requireValue(budget.bytes <= LIMIT.bytes && budget.blobRows <= LIMIT.rows && budget.scopes <= LIMIT.scopes, 'quota', 'The local image cache is full. Your source was kept.');
          for (const id of scopedRows.keys()) if (!nextRows.has(id)) blobs.delete([...scope, id]);
          for (const [id, row] of nextRows) { validateRow(row, [...scope, id]); blobs.put(row, [...scope, id]); }
          records.put(next, headKey); records.put(budget, budgetKey);
          result = { head: clone(next), rows: nextRows, value: mutation.value };
        } catch (caught) {
          if (!caught.savedHead && savedForError) { caught.savedHead = savedForError; caught.savedRows = rowsForError; }
          abort(caught);
        }
      };
      transaction.onabort = () => { transactions.delete(transaction); reject(problem || normalizeError(transaction.error)); };
      transaction.onerror = () => { /* onabort owns rejection and preserves the native transaction outcome. */ };
      transaction.oncomplete = () => {
        transactions.delete(transaction);
        try {
          guard();
          if (mode === 'readwrite' && result?.head && channel && scopeDigest) {
            try { channel.postMessage({ scopeDigest, headRevision: result.head.headRevision }); } catch { /* Notifications are advisory; CAS remains authoritative. */ }
          }
          resolve(result);
        } catch (caught) { reject(caught); }
      };
    });
  }
  function ready() {
    guard(); available();
    requireValue(state !== 'conflict', 'conflict', 'A newer saved draft or legacy source needs review. Your local input was kept.');
    requireValue(hydrated && head?.migration.state === 'ready', 'not_ready', 'Finish loading and saving this image draft before sending.'); checkMarker(head);
  }
  function requireSaved(value, scopedRows) {
    requireValue(value, 'corrupt');
    if (head && value.authorityId !== head.authorityId) throw staleDraft(value, scopedRows);
    if (value.migration.state !== 'ready') throw failure('not_ready', 'Image promotion is not complete.');
    checkMarker(value);
  }
  function commitResult() { return { committed: true, headRevision: head.headRevision, revision: head.draft.revision, snapshot }; }
  async function verifyBytes(row) {
    const actual = await imageData(row.blob, row.localId, row.uploadId); guard();
    requireValue(actual.rawSha256 === row.rawSha256 && actual.artifactId === row.artifactId && actual.bytes === row.bytes && actual.mimeType === row.mimeType,
      'corrupt', 'Saved image bytes did not match their original identity.');
  }
  async function verifyHead(value, scopedRows) {
    if (value.pending) requireValue(await sha(value.pending.serializedBody) === value.pending.serializedBodySha256);
    if (value.migration.legacyRaw !== null) requireValue(await sha(value.migration.legacyRaw) === value.migration.legacySourceSha256);
    guard();
    const missing = new Set(value.pending?.missingBytePins.map(pin => pin.localId) || []);
    const required = new Set([...value.draft.localIds, ...(value.pending?.submittedLocalIds || []), ...value.removals.map(job => job.localId)]);
    for (const id of required) {
      if (!scopedRows.has(id)) requireValue(missing.has(id) && !value.draft.localIds.includes(id), 'missing_bytes', 'Original image bytes are unavailable on this device.');
      else {
        requireValue(!missing.has(id));
        const row = scopedRows.get(id), index = value.pending?.submittedLocalIds.indexOf(id) ?? -1;
        if (index >= 0 && value.pending.kind === 'images-v1') {
          const attachment = value.pending.attachments[index];
          requireValue(['artifactId', 'mimeType', 'bytes', 'name'].every(field => row[field] === attachment[field])
            && row.readyDescriptor && equal(row.readyDescriptor, attachment));
        }
        await verifyBytes(row);
      }
    }
    requireValue([...scopedRows.keys()].every(id => required.has(id)));
  }
  async function importLegacy(raw) {
    requireValue(raw === null || bytes(raw) <= LIMIT.legacy, 'corrupt');
    let old = null;
    if (raw !== null) {
      try { old = JSON.parse(raw); } catch { throw failure('corrupt', 'The original draft is unreadable. Its source was kept.'); }
      requireValue(old?.version === 1 && old.home === scope[1].replace(/\/$/, '') && old.sessionId === scope[3]
        && typeof old.text === 'string' && UUID.test(old.revision)
        && (old.pending == null || UUID.test(old.pending.requestId) && UUID.test(old.pending.draftRevision) && typeof old.pending.text === 'string'));
    }
    let pending = null;
    if (old?.pending) {
      const prior = old.pending, image = Object.hasOwn(prior, 'attachments'), attachments = image ? cloneImageAttachments(prior.attachments) : null;
      const localIds = image ? attachments.map(() => createUuid()) : [];
      const body = image ? { requestId: prior.requestId, text: prior.text, attachments } : { text: `${prior.text}\n`, fallbackToMessage: true, requestId: prior.requestId };
      const serializedBody = JSON.stringify(body);
      pending = { kind: image ? 'images-v1' : 'legacy-text-v1', requestId: prior.requestId, text: prior.text, ...(image ? { attachments } : {}),
        draftRevision: prior.draftRevision, submittedLocalIds: localIds, missingBytePins: image ? localIds.map((localId, i) => ({ localId, attachment: attachments[i] })) : [],
        serializedBody, serializedBodySha256: await sha(serializedBody), rawSourceEvidence: image ? { kind: 'legacy_image_unknown' } : { kind: 'draft', revision: prior.draftRevision, localIds: [] }, acceptedReceipt: null };
    }
    guard();
    return { schemaVersion: 1, scope: [...scope], authorityId: createUuid(), headRevision: 0,
      draft: { revision: dirty ? displayed.revision : old?.revision || displayed.revision, rawText: dirty ? displayed.text : old?.text || '', localIds: [] }, pending, removals: [],
      migration: { state: 'copy_committed', legacyRaw: raw, legacySourceSha256: raw === null ? null : await sha(raw), expectedMarker: null, observedConflict: null } };
  }
  async function ensureChannel() {
    if (channel || typeof globalThis.BroadcastChannel !== 'function') return;
    const digest = await sha(scopeKey); guard();
    if (channel) return;
    scopeDigest = digest; channel = new BroadcastChannel('v4-composer-image-drafts-v1');
    channel.onmessage = event => {
      const value = event.data;
      if (!current() || !head || !keys(value, ['scopeDigest', 'headRevision']) || value.scopeDigest !== scopeDigest
        || !safe(value.headRevision) || value.headRevision <= head.headRevision) return;
      // Never adopt a remote whole-record snapshot or silently rebase a dirty
      // buffer. The next explicit operation reads and compares native state.
      error = failure('conflict', 'Another view saved changes to this draft. Its current revision will be checked before writing.'); publish();
    };
  }
  async function hydrateNow() {
    guard(); hydrating = true; publish();
    try {
      const raw = readLegacy(), stored = await data('readonly'); guard();
      legacyRaw = raw; captured = true;
      if (!stored.head) {
        requireValue(!decodeMarker(raw, scope), 'corrupt', 'The promoted draft is missing from IndexedDB. Its legacy marker was kept.');
        const imported = await importLegacy(raw); guard();
        adopt(imported, new Map(), dirty ? undefined : displayed.revision); state = 'legacy'; baseRevision = null; hydrated = true; publish();
      } else {
        if (dirty && stored.head.draft.revision !== (baseRevision || displayed.revision)) throw staleDraft(stored.head, stored.rows);
        // Keep readable raw/identity metadata visible if binary verification
        // fails, while withholding ready authority until all checks complete.
        head = clone(stored.head); rows = stored.rows;
        if (!dirty) displayed = { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] };
        state = 'unavailable'; publish();
        await verifyHead(stored.head, stored.rows); checkMarker(stored.head);
        adopt(stored.head, stored.rows, dirty ? undefined : displayed.revision); hydrated = true;
      }
      await ensureChannel(); guard();
      return snapshot;
    } finally { hydrating = false; publish(); }
  }
  async function flushNow() {
    ready(); if (!dirty) return commitResult();
    const submitted = { ...displayed, localIds: [...displayed.localIds] }, base = baseRevision;
    const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
      requireSaved(saved, scopedRows);
      if (saved.draft.revision !== base) throw staleDraft(saved, scopedRows);
      const next = clone(saved); next.draft = { revision: submitted.revision, rawText: submitted.text, localIds: [...saved.draft.localIds] };
      return { head: next, rows: new Map(scopedRows) };
    });
    checkMarker(result.head); adopt(result.head, result.rows, submitted.revision); return commitResult();
  }
  function assertRevision(value, expected, scopedRows) {
    if (value.draft.revision !== expected) throw staleDraft(value, scopedRows);
  }
  function retained(headValue, id) {
    return headValue.draft.localIds.includes(id) || headValue.pending?.submittedLocalIds.includes(id) || headValue.removals.some(job => job.localId === id);
  }
  function discardUnreferenced(headValue, scopedRows) {
    return new Map([...scopedRows].filter(([id]) => retained(headValue, id)));
  }
  function blobValue(row) {
    return Object.freeze({ blob: row.blob, localId: row.localId, uploadId: row.uploadId, mimeType: row.mimeType, bytes: row.bytes, name: row.name,
      artifactId: row.artifactId, rawSha256: row.rawSha256 });
  }
  async function readBlob(id, quietUnretainedMissing = false) {
    guard(); requireValue(typeof id === 'string' && UUID.test(id), 'invalid_input');
    const stored = await data('readonly'); guard();
    const row = stored.rows.get(id);
    if (!row) {
      const missing = failure('missing_bytes', 'Original image bytes are unavailable on this device. The previous request was kept.');
      // A queued preview can outlive successful cleanup. Reject that obsolete
      // lookup without replacing the current draft's public error state.
      if (quietUnretainedMissing && state === 'ready' && head && stored.head
        && head.authorityId === stored.head.authorityId && head.headRevision === stored.head.headRevision
        && !retained(head, id) && !retained(stored.head, id)) quietBlobReadFailures.add(missing);
      throw missing;
    }
    requireValue(stored.head && retained(stored.head, id));
    await verifyBytes(row); guard(); return row;
  }
  function validTicket(ticket, saved, row) {
    return issuedTickets.has(ticket) && ticket.scopeKey === scopeKey && ticket.authorityId === saved.authorityId && row
      && ticket.localId === row.localId && ticket.uploadId === row.uploadId && ticket.uploadGeneration === row.uploadGeneration
      && ticket.artifactId === row.artifactId && ticket.rawSha256 === row.rawSha256 && saved.draft.localIds.includes(row.localId)
      && row.uploadState === 'uploading';
  }
  function asIntent(value, reused) { return freeze({ ...clone(value), ...(reused === undefined ? {} : { reused }) }); }
  publish();
  // Remaining operations are below; no HTTP or automatic upload is performed.
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) { guard(); requireValue(typeof listener === 'function', 'invalid_input'); listeners.add(listener); return () => listeners.delete(listener); },
    hydrate() { return enqueue(hydrateNow, false); },
    promoteLegacy() { return enqueue(async () => {
      await ensureChannel();
      const observed = readLegacy(); let stored = await data('readonly');
      if (stored.head?.migration.state === 'ready') {
        checkMarker(stored.head); await verifyHead(stored.head, stored.rows);
        if (dirty && stored.head.draft.revision !== (baseRevision || displayed.revision)) throw staleDraft(stored.head, stored.rows);
        adopt(stored.head, stored.rows, dirty ? undefined : displayed.revision); hydrated = true; return snapshot;
      }
      let createdHere = false;
      if (!stored.head) {
        requireValue(!decodeMarker(observed, scope), 'corrupt', 'The promoted draft is missing. Its marker was kept.');
        if (captured && legacyRaw !== observed) { const problem = failure('conflict', 'The original draft changed while promotion was pending.'); problem.observedRaw = observed; throw problem; }
        const imported = await importLegacy(observed); guard();
        stored = await data('readwrite', ({ head: saved, rows: scopedRows }) => saved
          ? { changed: false, value: { createdHere: false } }
          : { head: imported, rows: new Map(scopedRows), value: { createdHere: true } });
        createdHere = stored.value?.createdHere === true;
      }
      requireValue(stored.head, 'corrupt');
      await verifyHead(stored.head, stored.rows); guard();
      const copyToken = { authorityId: stored.head.authorityId, headRevision: stored.head.headRevision,
        draftRevision: stored.head.draft.revision, legacyRaw: stored.head.migration.legacyRaw,
        legacySourceSha256: stored.head.migration.legacySourceSha256 };
      // A copy observed from another writer cannot become a dirty buffer's new
      // overwrite base. Only this attempt's acknowledged creation may supply it.
      const expectedBase = createdHere ? copyToken.draftRevision : baseRevision || displayed.revision;
      if (dirty && copyToken.draftRevision !== expectedBase) throw staleDraft(stored.head, stored.rows);
      head = clone(stored.head); rows = stored.rows; hydrated = true;
      if (createdHere || !dirty) baseRevision = head.draft.revision;
      if (!dirty) displayed = { text: head.draft.rawText, revision: head.draft.revision, localIds: [...head.draft.localIds] };
      state = head.migration.state; publish();
      requireValue(head.migration.state !== 'conflict', 'conflict', 'The original and promoted drafts need review.');
      const submittedRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        if (!saved || saved.authorityId !== copyToken.authorityId) throw staleDraft(saved, scopedRows);
        if (saved.migration.state === 'conflict') throw staleDraft(saved, scopedRows);
        if (saved.migration.state === 'ready') {
          checkMarker(saved);
          if (saved.migration.legacyRaw !== copyToken.legacyRaw || saved.migration.legacySourceSha256 !== copyToken.legacySourceSha256
            || dirty && saved.draft.revision !== expectedBase) throw staleDraft(saved, scopedRows);
          return { changed: false };
        }
        if (saved.migration.state !== 'copy_committed' || saved.headRevision !== copyToken.headRevision
          || saved.draft.revision !== copyToken.draftRevision || saved.migration.legacyRaw !== copyToken.legacyRaw
          || saved.migration.legacySourceSha256 !== copyToken.legacySourceSha256
          || dirty && saved.draft.revision !== expectedBase) throw staleDraft(saved, scopedRows);
        // The copy is already durably retained. Perform only synchronous marker
        // work under this fresh IDB state fence; neither storage is represented
        // as atomically committed with the other.
        const actual = readLegacy(), marker = markerFor(saved);
        if (actual !== saved.migration.legacyRaw && actual !== marker) {
          const problem = failure('conflict', 'A different legacy draft was observed after copying. Both drafts were kept.'); problem.observedRaw = actual; throw problem;
        }
        if (actual !== marker) legacy.writeMarker(marker);
        guard(); requireValue(readLegacy() === marker, 'conflict', 'The migration marker changed. Both drafts were kept.');
        const next = clone(saved); next.migration.state = 'ready'; next.migration.expectedMarker = marker;
        return { head: next, rows: new Map(scopedRows) };
      });
      if (dirty && result.head.draft.revision !== expectedBase) throw staleDraft(result.head, result.rows);
      checkMarker(result.head); adopt(result.head, result.rows, dirty ? undefined : submittedRevision); hydrated = true;
      if (dirty) await flushNow(); return snapshot;
    }); },
    setText(text) {
      guard(); requireValue(typeof text === 'string', 'invalid_input', 'Draft text must be a string.');
      if (text === displayed.text) return;
      displayed = { ...displayed, text, revision: createUuid() }; dirty = true; publish();
      if (hydrated && head?.migration.state === 'ready' && state !== 'conflict') enqueue(flushNow).catch(() => {});
    },
    flush() { return enqueue(flushNow); },
    addFiles(files, { expectedRevision } = {}) { return enqueue(async () => {
      ready(); requireValue(ids([expectedRevision]), 'invalid_input');
      requireValue(expectedRevision === displayed.revision, 'conflict', 'The draft changed before images could be added. Your files were kept.');
      requireValue(dense(files, file => file instanceof Blob) && files.length > 0, 'invalid_input', 'Choose between one and eight image files.');
      requireValue(displayed.localIds.length + files.length <= LIMIT.count
        && files.every(file => TYPES.has(file.type) && file.size > 0 && file.size <= LIMIT.image)
        && displayed.localIds.reduce((sum, id) => sum + (rows.get(id)?.bytes || 0), 0) + files.reduce((sum, file) => sum + file.size, 0) <= LIMIT.message,
      'invalid_input', 'Choose up to eight supported images, at most 8 MiB each and 16 MiB combined.');
      await flushNow();
      const priorFailed = [...failedAdds.values()];
      requireValue(!priorFailed.length || priorFailed.length === files.length, 'not_ready', 'Retry or remove the unsaved image batch before adding other images.');
      const candidates = files.map((file, index) => ({ localId: priorFailed[index]?.localId || createUuid(), uploadId: priorFailed[index]?.uploadId || createUuid(),
        blob: file, mimeType: file.type, bytes: file.size, name: typeof file.name === 'string' ? file.name : 'image.png',
        rawSha256: null, artifactId: null, uploadGeneration: 0, uploadState: 'local', readyDescriptor: null, expiresAt: null, errorCode: null }));
      for (const row of candidates) {
        try { descriptor({ attachmentId: row.uploadId, artifactId: '0'.repeat(64), mimeType: row.mimeType, bytes: row.bytes, name: row.name }); }
        catch { throw failure('invalid_input', 'The selected image filename or metadata is invalid.'); }
      }
      if (!priorFailed.length) { candidates.forEach(row => failedAdds.set(row.localId, row)); publish(); }
      const proposed = [];
      for (let i = 0; i < files.length; i += 1) { proposed.push(await imageData(files[i], candidates[i].localId, candidates[i].uploadId)); guard(); }
      if (priorFailed.length) {
        requireValue(priorFailed.every((row, i) => (row.artifactId ? row.artifactId === proposed[i].artifactId : row.blob === files[i]) && row.name === proposed[i].name),
          'not_ready', 'Retry or remove the unsaved image batch before adding other images.');
      }
      proposed.forEach(row => failedAdds.set(row.localId, row)); publish();
      const source = { ...displayed, localIds: [...displayed.localIds] };
      requireValue(source.revision === expectedRevision, 'conflict', 'The draft changed while image bytes were being read.');
      requireValue(source.localIds.length + proposed.length <= LIMIT.count, 'invalid_input', 'A message can contain at most eight images.');
      requireValue(source.localIds.reduce((sum, id) => sum + (rows.get(id)?.bytes || 0), 0) + proposed.reduce((sum, row) => sum + row.bytes, 0) <= LIMIT.message,
        'invalid_input', 'A message can contain at most 16 MiB of image bytes.');
      const nextRevision = createUuid();
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows); assertRevision(saved, expectedRevision, scopedRows);
        requireValue(saved.draft.localIds.length + proposed.length <= LIMIT.count, 'invalid_input');
        const nextRows = new Map(scopedRows); proposed.forEach(row => nextRows.set(row.localId, row));
        const next = clone(saved); next.draft = { revision: nextRevision, rawText: source.text, localIds: [...saved.draft.localIds, ...proposed.map(row => row.localId)] };
        requireValue(next.draft.localIds.reduce((sum, id) => sum + nextRows.get(id).bytes, 0) <= LIMIT.message, 'invalid_input');
        return { head: next, rows: nextRows };
      });
      guard(); checkMarker(result.head); proposed.forEach(row => failedAdds.delete(row.localId));
      adopt(result.head, result.rows, source.revision); return commitResult();
    }); },
    getBlob(localId) { return enqueue(async () => blobValue(await readBlob(localId, true)), false); },
    renewStartRevision({ expectedRevision, expectedLocalIds } = {}) { return enqueue(async () => {
      ready();
      requireValue(scope[3] === 'workspace-start' && UUID.test(expectedRevision) && ids(expectedLocalIds)
        && expectedLocalIds.length > 0, 'invalid_input', 'A saved start image draft is required.');
      requireValue(expectedRevision === displayed.revision && equal(expectedLocalIds, displayed.localIds), 'conflict', 'The saved start image draft changed. Review it before starting again.');
      await flushNow();
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows); assertRevision(saved, expectedRevision, scopedRows);
        requireValue(equal(saved.draft.localIds, expectedLocalIds) && !saved.pending && saved.removals.length === 0,
          'conflict', 'The saved start image draft changed. Review it before starting again.');
        const next = clone(saved); next.draft.revision = createUuid();
        return { head: next, rows: new Map(scopedRows) };
      });
      checkMarker(result.head); adopt(result.head, result.rows, expectedRevision); return commitResult();
    }); },
    beginUpload(localId) { return enqueue(async () => {
      ready(); const verified = await readBlob(localId); const sourceRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        const original = scopedRows.get(localId);
        requireValue(saved.draft.localIds.includes(localId) && original
          && ['localId', 'uploadId', 'artifactId', 'rawSha256', 'mimeType', 'bytes', 'name'].every(field => original[field] === verified[field]), 'not_ready', 'The selected image is no longer in this draft.');
        requireValue(!saved.pending?.submittedLocalIds.includes(localId), 'pending', 'The previous send still owns this image. Check its outcome before uploading again.');
        const row = rowCopy(original);
        if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
          // The server cannot renew an expired UUID. Pending pins are fenced above.
          row.uploadId = createUuid(); row.readyDescriptor = null; row.expiresAt = null;
        }
        row.uploadGeneration += 1; requireValue(safe(row.uploadGeneration)); row.uploadState = 'uploading'; row.errorCode = null;
        const nextRows = new Map(scopedRows); nextRows.set(localId, row);
        return { head: clone(saved), rows: nextRows };
      });
      checkMarker(result.head); const row = result.rows.get(localId);
      const ticket = Object.freeze({ ...blobValue(row), scopeKey, authorityId: result.head.authorityId, uploadGeneration: row.uploadGeneration });
      issuedTickets.add(ticket); issuedTicketIds.set(localId, row.uploadGeneration);
      adopt(result.head, result.rows, dirty ? undefined : sourceRevision); return ticket;
    }); },
    completeUpload(ticket, response) { return enqueue(async () => {
      ready(); requireValue(issuedTickets.has(ticket), 'invalid_input', 'The upload result has no current local ticket.');
      const verified = await readBlob(ticket.localId); const sourceRevision = displayed.revision;
      requireValue(keys(response, ['status', 'attachment', 'expiresAt']) && response.status === 'ready' && safe(response.expiresAt) && response.expiresAt > Date.now(), 'invalid_input', 'The upload receipt is invalid or expired.');
      let attachment;
      try { attachment = descriptor(response.attachment); } catch { throw failure('invalid_input', 'The upload receipt has invalid image metadata.'); }
      requireValue(attachment.attachmentId === ticket.uploadId && attachment.artifactId === verified.artifactId
        && attachment.mimeType === verified.mimeType && attachment.bytes === verified.bytes && attachment.name === verified.name,
        'invalid_input', 'The uploaded image did not match the saved image bytes.');
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows); const original = scopedRows.get(ticket.localId);
        if (!validTicket(ticket, saved, original)) return { changed: false, value: false };
        requireValue(!original.readyDescriptor || equal(original.readyDescriptor, attachment), 'invalid_input', 'The retry returned a different image identity for the same upload.');
        const row = rowCopy(original); row.uploadState = 'ready'; row.readyDescriptor = clone(attachment); row.expiresAt = response.expiresAt; row.errorCode = null;
        const nextRows = new Map(scopedRows); nextRows.set(row.localId, row);
        return { head: clone(saved), rows: nextRows, value: true };
      });
      checkMarker(result.head); if (result.value === true) issuedTicketIds.delete(ticket.localId);
      adopt(result.head, result.rows, dirty ? undefined : sourceRevision);
      return { applied: result.value === true, ...(result.value === true ? {} : { reason: 'stale' }), snapshot };
    }); },
    failUpload(ticket, detail) { return enqueue(async () => {
      ready(); requireValue(issuedTickets.has(ticket), 'invalid_input');
      requireValue(keys(detail, ['code', 'message']) && typeof detail.code === 'string' && detail.code.length > 0 && detail.code.length <= 80 && typeof detail.message === 'string' && detail.message.length <= 400, 'invalid_input');
      const sourceRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows); const original = scopedRows.get(ticket.localId);
        if (!validTicket(ticket, saved, original)) return { changed: false, value: false };
        const row = rowCopy(original); row.uploadState = 'failed'; row.errorCode = detail.code;
        const nextRows = new Map(scopedRows); nextRows.set(row.localId, row);
        return { head: clone(saved), rows: nextRows, value: true };
      });
      checkMarker(result.head); if (result.value === true) issuedTicketIds.delete(ticket.localId);
      adopt(result.head, result.rows, dirty ? undefined : sourceRevision);
      return { applied: result.value === true, ...(result.value === true ? {} : { reason: 'stale' }), snapshot };
    }); },
    removeImage(localId, { expectedRevision } = {}) { return enqueue(async () => {
      guard();
      if (failedAdds.has(localId)) { failedAdds.delete(localId); error = null; publish(); return { committed: false, reason: 'local_only', snapshot }; }
      ready(); requireValue(expectedRevision === displayed.revision, 'conflict', 'The draft changed before this image could be removed.');
      await flushNow(); const sourceRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows); assertRevision(saved, expectedRevision, scopedRows);
        const row = scopedRows.get(localId); requireValue(row && saved.draft.localIds.includes(localId), 'invalid_input', 'The image is not selected in this draft.');
        const next = clone(saved), nextRows = new Map(scopedRows);
        next.draft.localIds = next.draft.localIds.filter(id => id !== localId); next.draft.revision = createUuid();
        if (!next.pending?.submittedLocalIds.includes(localId) && row.uploadGeneration > 0) {
          const removed = rowCopy(row); removed.uploadGeneration += 1; requireValue(safe(removed.uploadGeneration)); removed.uploadState = 'removing';
          nextRows.set(localId, removed); next.removals.push({ localId, uploadId: removed.uploadId, uploadGeneration: removed.uploadGeneration });
        }
        return { head: next, rows: discardUnreferenced(next, nextRows) };
      });
      checkMarker(result.head); adopt(result.head, result.rows, sourceRevision); return commitResult();
    }); },
    completeRemoval(job) { return enqueue(async () => {
      ready(); requireValue(keys(job, ['uploadId', 'uploadGeneration']) && UUID.test(job.uploadId) && safe(job.uploadGeneration), 'invalid_input');
      const sourceRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        const matching = saved.removals.find(value => value.uploadId === job.uploadId && value.uploadGeneration === job.uploadGeneration);
        requireValue(matching, 'conflict', 'This removal has already changed. Its saved source was kept.');
        const next = clone(saved); next.removals = next.removals.filter(value => value !== matching && !(value.uploadId === matching.uploadId && value.uploadGeneration === matching.uploadGeneration));
        return { head: next, rows: discardUnreferenced(next, scopedRows) };
      });
      checkMarker(result.head); adopt(result.head, result.rows, dirty ? undefined : sourceRevision); return commitResult();
    }); },
    prepareIntent(input) { return enqueue(async () => {
      requireValue(hydrated && head?.migration.state === 'ready', 'not_ready', 'Load and save the image draft before preparing a request.'); ready();
      requireValue(keys(input, ['text', 'draftRevision', 'localIds'], ['attachments', 'requestId']) && typeof input.text === 'string' && UUID.test(input.draftRevision) && ids(input.localIds)
        && (!Object.hasOwn(input, 'requestId') || UUID.test(input.requestId)), 'invalid_input');
      const image = Object.hasOwn(input, 'attachments'); let attachments;
      try { attachments = image ? cloneImageAttachments(input.attachments) : null; } catch { throw failure('invalid_input', 'Ready image references could not be verified.'); }
      requireValue(image ? attachments.length === input.localIds.length : input.localIds.length === 0, 'invalid_input');
      requireValue(image || input.text.trim().length > 0, 'invalid_input', 'A text-only message cannot be empty.');
      requireValue(input.draftRevision === displayed.revision && equal(input.localIds, displayed.localIds), 'conflict', 'The draft changed before Send could be prepared.');
      await flushNow();
      // Canonical input is consumed verbatim. Never reproject stored retry text.
      const candidateBody = { requestId: input.requestId || createUuid(), text: input.text, ...(image ? { attachments } : {}) };
      const body = image ? candidateBody : { text: `${input.text}\n`, fallbackToMessage: true, requestId: candidateBody.requestId };
      const serializedBody = JSON.stringify(body), bodyHash = await sha(serializedBody); guard();
      for (const id of input.localIds) await readBlob(id);
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        if (saved.pending) {
          const same = image && saved.pending.kind === 'images-v1' ? sameImageInput({ text: input.text, attachments }, { text: saved.pending.text, attachments: saved.pending.attachments })
            : !image && saved.pending.kind === 'legacy-text-v1' && saved.pending.text === input.text;
          requireValue(same && (!input.requestId || saved.pending.requestId === input.requestId), 'pending', 'A different previous send is unresolved. Check its original request before sending another body.');
          return { changed: false, value: { reused: true } };
        }
        assertRevision(saved, input.draftRevision, scopedRows); requireValue(equal(saved.draft.localIds, input.localIds), 'conflict');
        requireValue(saved.removals.length === 0 && failedAdds.size === 0, 'not_ready', 'Finish saving and removing images before sending.');
        input.localIds.forEach((id, index) => {
          const row = scopedRows.get(id);
          requireValue(row && row.uploadState === 'ready' && row.expiresAt > Date.now() && equal(row.readyDescriptor, attachments[index]), 'not_ready', 'Every selected image must have a current ready upload.');
        });
        const next = clone(saved); next.pending = { kind: image ? 'images-v1' : 'legacy-text-v1', requestId: candidateBody.requestId, text: input.text,
          ...(image ? { attachments: clone(attachments) } : {}), draftRevision: input.draftRevision, submittedLocalIds: [...input.localIds], missingBytePins: [],
          serializedBody, serializedBodySha256: bodyHash, rawSourceEvidence: { kind: 'draft', revision: input.draftRevision, localIds: [...input.localIds] }, acceptedReceipt: null };
        return { head: next, rows: new Map(scopedRows), value: { reused: false } };
      });
      requireValue(await sha(result.head.pending.serializedBody) === result.head.pending.serializedBodySha256); guard();
      checkMarker(result.head); adopt(result.head, result.rows, dirty ? undefined : input.draftRevision);
      return asIntent(head.pending, result.value.reused);
    }); },
    getPendingIntent() { guard(); return head?.pending ? asIntent(head.pending) : null; },
    confirmIntent({ requestId, receipt } = {}) { return enqueue(async () => {
      ready(); requireValue(UUID.test(requestId), 'invalid_input');
      const originalBase = { authorityId: head.authorityId, draftRevision: baseRevision };
      // Phase1 retains proof and pins; it does not clear or garbage-collect the
      // source draft. Its own receipt write cannot grant a new draft base.
      const proofCommit = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        if (saved.authorityId !== originalBase.authorityId || saved.draft.revision !== originalBase.draftRevision) throw staleDraft(saved, scopedRows);
        if (saved.pending?.requestId !== requestId) throw staleDraft(saved, scopedRows);
        requireValue(receiptMatches(receipt, saved.pending), 'receipt_mismatch', 'The previous send receipt did not match its saved identity and images.');
        requireValue(!saved.pending.acceptedReceipt || sameReceiptIdentity(saved.pending.acceptedReceipt, receipt, saved.pending),
          'receipt_mismatch', 'The receipt contradicts the durable identity of this accepted send.');
        const proof = receiptProof(receipt, saved.pending);
        if (equal(saved.pending.acceptedReceipt, proof)) return { changed: false };
        const next = clone(saved); next.pending.acceptedReceipt = proof;
        return { head: next, rows: new Map(scopedRows) };
      });
      guard(); checkMarker(proofCommit.head);
      const token = { authorityId: proofCommit.head.authorityId, headRevision: proofCommit.head.headRevision,
        draft: clone(proofCommit.head.draft), pending: clone(proofCommit.head.pending) };
      // Adopt the proven receipt only. Preserve the original local draft/base,
      // including raw typing which arrived while the first transaction ran.
      head = clone(proofCommit.head); rows = proofCommit.rows; state = head.migration.state; error = null; conflict = null;
      const pending = token.pending;
      const cleared = !dirty && pending.rawSourceEvidence.kind === 'draft' && displayed.revision === pending.draftRevision
        && equal(displayed.localIds, pending.submittedLocalIds) && token.draft.revision === pending.draftRevision
        && equal(token.draft.localIds, pending.submittedLocalIds);
      // This choice is synchronous after phase1complete and before phase2 is
      // created. Subsequent typing inherits this actually visible selection.
      const clearedRevision = cleared ? createUuid() : null;
      if (cleared) { displayed = { text: '', revision: clearedRevision, localIds: [] }; dirty = true; }
      const chosenIds = [...displayed.localIds]; publish();
      const finalized = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        if (saved.authorityId !== token.authorityId || saved.headRevision !== token.headRevision || !equal(saved.draft, token.draft)
          || !equal(saved.pending, token.pending) || baseRevision !== originalBase.draftRevision) throw staleDraft(saved, scopedRows);
        requireValue(equal(displayed.localIds, chosenIds), 'conflict', 'The selected draft images changed before local cleanup.');
        const chosen = { revision: displayed.revision, rawText: displayed.text, localIds: [...displayed.localIds] };
        requireValue(chosen.localIds.every(id => scopedRows.has(id)), 'missing_bytes', 'Selected image bytes are unavailable. The accepted proof was kept.');
        const next = clone(saved); next.draft = chosen; next.pending = null;
        return { head: next, rows: discardUnreferenced(next, scopedRows), value: { chosenRevision: chosen.revision } };
      });
      checkMarker(finalized.head); adopt(finalized.head, finalized.rows, finalized.value.chosenRevision);
      return { committed: true, clearedDraft: cleared && !dirty && displayed.revision === clearedRevision, snapshot };
    }); },
    restorePendingBytes({ requestId, files } = {}) { return enqueue(async () => {
      ready(); requireValue(head.pending?.requestId === requestId && head.pending.kind === 'images-v1', 'pending', 'No matching previous image send is available.');
      const pins = clone(head.pending.missingBytePins); requireValue(pins.length > 0 && Array.isArray(files) && files.length === pins.length, 'invalid_input', 'Choose the original missing images in their original order.');
      const restored = [];
      for (let i = 0; i < pins.length; i += 1) {
        const attachment = pins[i].attachment;
        const row = await imageData(files[i], pins[i].localId, attachment.attachmentId); guard();
        requireValue(row.artifactId === attachment.artifactId && row.mimeType === attachment.mimeType && row.bytes === attachment.bytes && row.name === attachment.name,
          'invalid_input', 'The selected bytes do not match the original image request.');
        row.readyDescriptor = attachment; row.uploadState = 'unknown'; restored.push(row);
      }
      const sourceRevision = displayed.revision;
      const result = await data('readwrite', ({ head: saved, rows: scopedRows }) => {
        requireSaved(saved, scopedRows);
        requireValue(saved.pending?.requestId === requestId && equal(saved.pending.missingBytePins, pins), 'conflict');
        const next = clone(saved), nextRows = new Map(scopedRows); restored.forEach(row => nextRows.set(row.localId, row)); next.pending.missingBytePins = [];
        return { head: next, rows: nextRows };
      });
      checkMarker(result.head); adopt(result.head, result.rows, dirty ? undefined : sourceRevision); return commitResult();
    }); },
    close() {
      if (closed) return; closed = true;
      globalThis.window?.removeEventListener('focus', refreshReadiness);
      globalThis.document?.removeEventListener('visibilitychange', refreshReadiness);
      for (const transaction of transactions) { try { transaction.abort(); } catch { /* Already committed transactions remain recoverable. */ } }
      transactions.clear(); db?.close(); db = null; opening = null; channel?.close(); channel = null; issuedTicketIds.clear(); listeners.clear(); options.signal?.removeEventListener('abort', abortTransactions); publish();
    },
  };
  function abortTransactions() {
    clearTimeout(expiryTimer); expiryTimer = null;
    for (const transaction of transactions) { try { transaction.abort(); } catch { /* A completed old-scope write stays in its original scope. */ } }
  }
  function refreshReadiness() { if (current()) publish(); }
  globalThis.window?.addEventListener('focus', refreshReadiness);
  globalThis.document?.addEventListener('visibilitychange', refreshReadiness);
  options.signal?.addEventListener('abort', abortTransactions, { once: true });
  return store;
}
