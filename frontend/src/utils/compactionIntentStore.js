import { createUuid } from './createUuid';
import { getEnvironmentSignal, getEnvironmentStorage } from './remoteEnvironments';
import { resolveHomeApiUrl } from './apiBase';
import { COMPACT_UUID, COMPACT_REVISION, COMPACT_TERMINAL, encodedBytes, object, validCompactionBody, validateCompactReceipt, validateCompactionInstructions, validateHistoryReceipt } from './compactionControl';

const scopes = new WeakMap(), MAX_RECORD = 192000;
const READ_ERROR = 'Saved compaction work could not be read. Its possible command identity was kept. Restore device storage before compacting.';
const SAVE_ERROR = 'Compaction work could not be saved on this device. Your instructions and command identity were kept. Free local storage and retry.';
const CHANGE_ERROR = 'Saved compaction work changed in another window. Close and reopen context before changing it.';
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => JSON.parse(JSON.stringify(value));
const instructionText = value => typeof value === 'string' && value.length <= 8000 && encodedBytes(value) <= 32000;

function createStore(sessionId, home, signal) {
  const storage = getEnvironmentStorage(), key = `compactionIntent:v1:${encodeURIComponent(home)}:${sessionId}`, listeners = new Set();
  const fresh = () => ({ version: 1, home, sessionId, instructions: '', draftRevision: createUuid(), pending: null, lastCommand: null });
  let record = fresh(), savedRaw = null, error = '', corrupt = false, dirtyDraft = false, lease = null, snapshot;
  function publish() { snapshot = freeze({ ...copy(record), error, isSending: Boolean(lease) }); listeners.forEach(listener => listener()); }
  function validate(raw) {
    if (raw == null) return fresh();
    if (encodedBytes(raw) > MAX_RECORD) throw new Error(READ_ERROR);
    const value = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || value.home !== home || value.sessionId !== sessionId
      || !instructionText(value.instructions) || !COMPACT_UUID.test(value.draftRevision)) throw new Error(READ_ERROR);
    if (value.pending != null) {
      const pending = value.pending;
      if (!object(pending) || !validCompactionBody(pending.body) || !COMPACT_UUID.test(pending.draftRevision) || !['uncertain', 'accepted'].includes(pending.phase)
        || (pending.phase === 'accepted') !== (pending.receipt != null)) throw new Error(READ_ERROR);
      if (pending.receipt != null) validateCompactReceipt(pending.receipt, pending.body.requestId);
    }
    if (value.lastCommand != null) {
      const last = value.lastCommand;
      if (!object(last) || !validCompactionBody(last.body) || !object(last.outcome) || !COMPACT_TERMINAL.has(last.outcome.status)
        || typeof last.outcome.turnId !== 'string' || !last.outcome.turnId || !Number.isSafeInteger(last.outcome.acceptedSeq) || last.outcome.acceptedSeq < 1
        || typeof last.outcome.detailsUnavailable !== 'boolean'
        || (last.outcome.message != null && (typeof last.outcome.message !== 'string' || last.outcome.message.length > 4096))
        || (last.outcome.receipt == null ? !last.outcome.detailsUnavailable
          : last.outcome.status !== 'completed' || last.outcome.detailsUnavailable || !validateHistoryReceipt(last.outcome.receipt, last.body.expectedRevision))) throw new Error(READ_ERROR);
    }
    return value;
  }
  function refresh() {
    if (signal.aborted) return;
    try {
      const raw = storage.getItem(key);
      if (raw === savedRaw && !corrupt) return;
      const restored = validate(raw); savedRaw = raw;
      record = dirtyDraft ? { ...restored, instructions: record.instructions, draftRevision: record.draftRevision } : restored;
      corrupt = false; error = ''; publish();
    } catch { corrupt = true; error = READ_ERROR; publish(); }
  }
  // This is a stale-writer guard, not a cross-window transactional lock.
  function save(next, required = true) {
    try {
      if (signal.aborted) throw new Error('This compaction scope is no longer active.');
      if (corrupt) throw new Error(READ_ERROR);
      if (storage.getItem(key) !== savedRaw) throw new Error(CHANGE_ERROR);
      const raw = JSON.stringify(next); if (encodedBytes(raw) > MAX_RECORD) throw new Error(SAVE_ERROR);
      storage.setItem(key, raw); savedRaw = raw; record = next; dirtyDraft = false; error = ''; publish(); return true;
    } catch (failure) {
      if (!required) record = next;
      error = [READ_ERROR, CHANGE_ERROR].includes(failure.message) ? failure.message : SAVE_ERROR; publish();
      if (required) throw new Error(error); return false;
    }
  }
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, refresh,
    retrySave() {
      if (signal.aborted) return false;
      refresh();
      try { return save(record); } catch { return false; }
    },
    setInstructions(instructions) {
      if (signal.aborted || typeof instructions !== 'string' || instructions === record.instructions) return;
      if (!instructionText(instructions)) { error = 'Compaction instructions must be at most 4,000 Unicode characters.'; publish(); return; }
      dirtyDraft = true; save({ ...record, instructions, draftRevision: createUuid() }, false);
    },
    prepareIntent(expectedRevision) {
      if (corrupt) refresh();
      if (corrupt) throw new Error(READ_ERROR);
      if (record.pending) throw new Error('An unresolved compaction command must be confirmed before creating another.');
      if (!COMPACT_REVISION.test(expectedRevision)) throw new Error('Refresh context before compacting.');
      const invalid = validateCompactionInstructions(record.instructions); if (invalid) throw new Error(invalid);
      const pending = { body: { requestId: createUuid(), instructions: record.instructions === '' ? null : record.instructions, expectedRevision }, draftRevision: record.draftRevision, phase: 'uncertain', receipt: null };
      save({ ...record, pending }); return copy(pending);
    },
    accept(receipt) {
      const pending = record.pending; if (!pending || signal.aborted) return;
      validateCompactReceipt(receipt, pending.body.requestId);
      if (pending.receipt && (pending.receipt.turnId !== receipt.turnId || pending.receipt.acceptedSeq !== receipt.acceptedSeq)) throw new Error('Compaction receipt identity changed.');
      const next = { ...record, pending: { ...pending, phase: 'accepted', receipt: copy(receipt) } };
      if (record.draftRevision === pending.draftRevision) { next.instructions = ''; next.draftRevision = createUuid(); }
      save(next);
    },
    rejectInitial(requestId) {
      if (record.pending?.body.requestId === requestId && record.pending.receipt == null) save({ ...record, pending: null });
    },
    settle(requestId, outcome) {
      const pending = record.pending;
      if (!pending || pending.body.requestId !== requestId || !COMPACT_TERMINAL.has(outcome.status) || pending.receipt?.turnId !== outcome.turnId) return;
      save({ ...record, pending: null, lastCommand: { body: pending.body, outcome: copy(outcome) } });
    },
    claim() { if (signal.aborted || lease) return null; lease = {}; publish(); return lease; },
    release(expected) { if (lease === expected) { lease = null; publish(); } },
  };
  refresh(); if (!snapshot) publish(); return store;
}

export function getCompactionIntentStore(sessionId) {
  const signal = getEnvironmentSignal(); let scope = scopes.get(signal);
  if (!scope) { scope = new Map(); scopes.set(signal, scope); }
  const home = new URL(resolveHomeApiUrl('') || window.location.origin, window.location.origin).href.replace(/\/$/, '');
  const key = `${home}:${sessionId}`;
  if (!scope.has(key)) scope.set(key, createStore(sessionId, home, signal));
  return scope.get(key);
}
