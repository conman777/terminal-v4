import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { getCompactionIntentStore } from '../utils/compactionIntentStore';
import { COMPACT_TERMINAL, encodedBytes, getCompactionOutcome, object, safeCount, textBound, validateCompactReceipt, validateCompactionInstructions, validateContextSnapshot } from '../utils/compactionControl';

const MAX_SNAPSHOT = 16 * 1024 * 1024;
const unknown = 'Compaction outcome is awaiting confirmation. Its exact command identity was kept. Check the outcome or retry the same command.';
const initialRejection = status => [400, 401, 403, 404, 409, 413, 422].includes(status);
const terminalDetailsMissing = 'The host confirms the command status, but compaction result details are not available.';

// Bound real response streams before parsing. The json fallback supports small
// connector/test responses; it is still checked before any receipt is trusted.
async function readJson(response, limit) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > limit) throw new Error('The host response is too large to verify safely. The command identity was kept.');
  let value;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let total = 0, text = '';
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > limit) { await reader.cancel(); throw new Error('The host response is too large to verify safely.'); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode(); value = JSON.parse(text);
    } finally { reader.releaseLock(); }
  } else value = await response.json();
  if (encodedBytes(value) > limit) throw new Error('The host response is too large to verify safely.');
  return value;
}
const publicError = (body, fallback) => textBound(body?.error) && body.error ? body.error : fallback;

export function useCompactionControl(props) {
  const { sessionId, active = true, controlState } = props;
  const scopeSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const store = useMemo(() => getCompactionIntentStore(sessionId), [sessionId, scopeSignal]);
  const saved = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [view, setView] = useState({ token: null, context: null, loading: true, error: '', stopFailure: '', healthBarrier: false, localStopping: false });
  const scope = useRef(null), latestProps = useRef(props); latestProps.current = props;
  const current = ctx => Boolean(ctx && scope.current === ctx && ctx.sessionId === latestProps.current.sessionId && latestProps.current.active !== false
    && ctx.environmentSignal === getEnvironmentSignal() && !ctx.controller.signal.aborted && !ctx.environmentSignal.aborted);
  const endpoint = ctx => `/api/structured/sessions/${encodeURIComponent(ctx.sessionId)}`;
  const update = (ctx, patch) => { if (current(ctx)) setView(previous => ({ ...previous, token: ctx, ...patch })); };
  const signal = ctx => AbortSignal.any([ctx.controller.signal, ctx.environmentSignal, AbortSignal.timeout(30000)]);

  async function reloadContext(ctx) {
    if (!ctx || !current(ctx) || ctx.remote) return null;
    const generation = ++ctx.loadGeneration, replayGeneration = ctx.controlGeneration;
    const loadCurrent = () => {
      const controls = latestProps.current.controlState;
      return current(ctx) && generation === ctx.loadGeneration && replayGeneration === ctx.controlGeneration
        && (!(controls?.sessionId === ctx.sessionId && safeCount(controls.generation)) || controls.generation === replayGeneration);
    };
    update(ctx, { loading: true });
    try {
      const response = await apiFetch(`${endpoint(ctx)}/context`, { signal: signal(ctx) });
      const body = await readJson(response, 65536);
      if (!loadCurrent()) return null;
      if (!response.ok) throw new Error(publicError(body, `Context could not be loaded (${response.status}).`));
      const context = validateContextSnapshot(body, ctx.sessionId);
      ctx.context = context; ctx.projectionReset = false;
      if (context.sampleStatus === 'current' && context.blockedReason !== 'cleanup_required') ctx.healthBarrier = false;
      update(ctx, { context, loading: false, healthBarrier: ctx.healthBarrier }); return context;
    } catch (error) {
      if (loadCurrent()) { ctx.context = null; update(ctx, { context: null, loading: false, error: error.message || 'Context could not be loaded.' }); }
      return null;
    }
  }

  function remember(ctx, body, outcome) {
    if (!current(ctx) || ctx.store.getSnapshot().pending?.body.requestId !== body.requestId) return false;
    ctx.store.accept({ requestId: body.requestId, turnId: outcome.turnId, acceptedSeq: outcome.acceptedSeq, status: outcome.status });
    if (COMPACT_TERMINAL.has(outcome.status)) ctx.store.settle(body.requestId, outcome);
    update(ctx, { error: '' }); return true;
  }

  async function readCommand(ctx, pending) {
    const body = pending.body;
    const response = await apiFetch(`${endpoint(ctx)}/requests/${body.requestId}`, { signal: signal(ctx) });
    if (!current(ctx)) return { stale: true };
    let receipt = null;
    if (response.status !== 404) {
      const value = await readJson(response, 65536);
      if (!current(ctx)) return { stale: true };
      if (!response.ok) throw new Error(publicError(value, `Compaction could not be checked (${response.status}). ${unknown}`));
      receipt = validateCompactReceipt(value, body.requestId);
    }
    // A 404 receipt alone does not prove absence: the journal may already have
    // accepted the exact command. Check it before any explicit retry POST.
    const snapshotResponse = await apiFetch(endpoint(ctx), { signal: signal(ctx) });
    const snapshot = await readJson(snapshotResponse, MAX_SNAPSHOT);
    if (!current(ctx)) return { stale: true };
    if (!snapshotResponse.ok) throw new Error(publicError(snapshot, unknown));
    if (!object(snapshot) || snapshot.id !== ctx.sessionId || snapshot.runtime !== 'v4' || !Array.isArray(snapshot.events) || snapshot.events.length > 32768) throw new Error('Canonical command evidence is unavailable. Its identity was kept.');
    const outcome = getCompactionOutcome(snapshot.events, body);
    if (!outcome) {
      if (receipt) throw new Error('A command receipt exists, but its exact canonical command could not be confirmed. Its identity was kept.');
      return { known: false };
    }
    if (receipt && (receipt.turnId !== outcome.turnId || receipt.acceptedSeq !== outcome.acceptedSeq)) throw new Error('Canonical command identity does not match the receipt.');
    if (['cleanup_required', 'reconciliation_required'].includes(receipt?.status) || ['cleanup_required', 'reconciliation_required'].includes(snapshot.status)) {
      ctx.healthBarrier = true; update(ctx, { healthBarrier: true });
    }
    remember(ctx, body, outcome);
    if (COMPACT_TERMINAL.has(outcome.status)) await reloadContext(ctx);
    return { known: true, outcome };
  }

  async function perform(ctx, mode) {
    if (!ctx || !current(ctx) || ctx.remote) return { accepted: false };
    const lease = ctx.store.claim(); if (!lease) return { accepted: false, pending: true };
    ctx.lease = lease; update(ctx, { error: '' });
    let pending = ctx.store.getSnapshot().pending, initial = false;
    try {
      if (mode === 'submit') {
        if (pending || !canSubmitNow(ctx)) return { accepted: false };
        pending = ctx.store.prepareIntent(ctx.context.conversationRevision); initial = true;
      } else {
        if (!pending) return { accepted: false };
        const checked = await readCommand(ctx, pending);
        if (!current(ctx) || checked.stale) return { accepted: false, stale: true };
        if (checked.known) return { accepted: true, ...checked };
        if (mode === 'reconcile') { update(ctx, { error: unknown }); return { accepted: false, unknown: true }; }
        if (!canExecute(ctx)) { update(ctx, { error: 'The conversation must be idle and cleanup confirmed before retrying compaction.' }); return { accepted: false }; }
      }
      if (!current(ctx)) return { accepted: false, stale: true };
      const response = await apiFetch(`${endpoint(ctx)}/compact`, { method: 'POST', body: pending.body, signal: signal(ctx) });
      const value = await readJson(response, 65536);
      if (!current(ctx)) return { accepted: false, stale: true };
      const settled = ctx.store.getSnapshot().lastCommand;
      if (settled?.body.requestId === pending.body.requestId) return { accepted: true, outcome: settled.outcome };
      if (!response.ok) {
        if (initial && initialRejection(response.status)) ctx.store.rejectInitial(pending.body.requestId);
        const message = publicError(value, `Compaction was not accepted (${response.status}).`);
        update(ctx, { error: initial ? message : `${message} ${unknown}` });
        if (initial) await reloadContext(ctx);
        return { accepted: false };
      }
      const receipt = validateCompactReceipt(value, pending.body.requestId);
      ctx.store.accept(receipt);
      if (['cleanup_required', 'reconciliation_required'].includes(receipt.status)) { ctx.healthBarrier = true; update(ctx, { healthBarrier: true }); }
      if (COMPACT_TERMINAL.has(receipt.status)) await readCommand(ctx, ctx.store.getSnapshot().pending);
      return { accepted: true, receipt };
    } catch (failure) {
      const settled = ctx.store.getSnapshot().lastCommand;
      if (current(ctx) && pending && settled?.body.requestId === pending.body.requestId) return { accepted: true, outcome: settled.outcome };
      if (current(ctx)) update(ctx, { error: `${failure.message || 'Compaction could not be confirmed.'}${pending ? ` ${unknown}` : ''}` });
      return { accepted: false, ...(current(ctx) ? {} : { stale: true }) };
    } finally { ctx.store.release(lease); if (ctx.lease === lease) ctx.lease = null; }
  }

  function canExecute(ctx) {
    const now = latestProps.current;
    return current(ctx) && !ctx.remote && !now.readOnly && !now.conversationBusy && !now.requiresCleanup && !ctx.healthBarrier;
  }
  function isStale(ctx) {
    const controls = latestProps.current.controlState;
    return Boolean(ctx.projectionReset || (controls?.sessionId === ctx.sessionId && safeCount(controls.generation) && controls.generation !== ctx.controlGeneration)
      || (ctx.context && controls?.sessionId === ctx.sessionId && safeCount(controls.latestSeq) && controls.latestSeq > ctx.context.asOfSeq));
  }
  function canSubmitNow(ctx) {
    return canExecute(ctx) && ctx.context?.canCompact === true && !isStale(ctx)
      && !ctx.store.getSnapshot().pending && !ctx.store.getSnapshot().error && !validateCompactionInstructions(ctx.store.getSnapshot().instructions);
  }

  useEffect(() => {
    if (!active || !sessionId) { scope.current = null; return undefined; }
    const ctx = { sessionId, store, environmentSignal: scopeSignal, controller: new AbortController(), remote: Boolean(getActiveEnvironment()), loadGeneration: 0,
      controlGeneration: controlState?.sessionId === sessionId && safeCount(controlState.generation) ? controlState.generation : 0, projectionReset: false, context: null, healthBarrier: false, lease: null,
      recovery: { requestId: null, generation: null, gapMarker: null, truncated: false, edge: 0, keys: new Set(), attempts: 0 } };
    scope.current = ctx;
    store.refresh();
    setView({ token: ctx, context: null, loading: !ctx.remote, error: ctx.remote ? 'Context controls are available on the local host. Paired context reads are not supported.' : '', stopFailure: '', healthBarrier: false, localStopping: false });
    if (!ctx.remote) void (async () => {
      await reloadContext(ctx);
      if (current(ctx) && ctx.store.getSnapshot().pending) await perform(ctx, 'reconcile');
    })();
    return () => { ctx.controller.abort(); if (ctx.lease) ctx.store.release(ctx.lease); if (scope.current === ctx) scope.current = null; };
  }, [sessionId, active, scopeSignal, store]);

  useEffect(() => {
    const ctx = scope.current, controls = controlState;
    if (!ctx || !current(ctx) || controls?.sessionId !== sessionId || !safeCount(controls.generation) || controls.generation < ctx.controlGeneration) return;
    if (controls.generation > ctx.controlGeneration) {
      ctx.projectionReset = true; ctx.loadGeneration += 1;
      ctx.recovery.gapMarker = `reset:${controls.generation}`; update(ctx, { loading: false });
    }
    if (controls.truncated && !ctx.recovery.truncated) ctx.recovery.gapMarker = `truncated:${controls.generation}:${++ctx.recovery.edge}`;
    ctx.recovery.truncated = controls.truncated === true;
    ctx.controlGeneration = controls.generation;
    const pending = ctx.store.getSnapshot().pending;
    if (!pending || !Array.isArray(controls.events) || controls.events.length > 64 || encodedBytes(controls.events) > 256000) return;
    try {
      const outcome = getCompactionOutcome(controls.events, pending.body);
      if (outcome && remember(ctx, pending.body, outcome) && COMPACT_TERMINAL.has(outcome.status)) { void reloadContext(ctx); return; }
      const recovery = ctx.recovery;
      if (recovery.requestId !== pending.body.requestId || recovery.generation !== controls.generation) {
        recovery.requestId = pending.body.requestId; recovery.generation = controls.generation; recovery.keys.clear(); recovery.attempts = 0;
      }
      // Truncation stays true after old entries are evicted. Recover once at its
      // edge/reset, then only for a matching terminal turn, never every token seq.
      const terminal = pending.receipt?.turnId ? controls.events.findLast(event => event?.turnId === pending.receipt.turnId && safeCount(event.seq)
        && ((event.type === 'turn_completed' && COMPACT_TERMINAL.has(event.status)) || (event.type === 'compaction' && ['completed', 'failed'].includes(event.status)))) : null;
      const gapKey = recovery.gapMarker, terminalKey = terminal ? `terminal:${terminal.seq}` : null;
      const marker = terminalKey && !recovery.keys.has(terminalKey) ? terminalKey : gapKey && !recovery.keys.has(gapKey) ? gapKey : null;
      if (!marker || ctx.store.getSnapshot().isSending) return;
      if (recovery.attempts >= 4) { update(ctx, { error: `${unknown} Automatic read recovery is limited; use Check compaction outcome.` }); return; }
      recovery.attempts += 1;
      if (gapKey) recovery.keys.add(gapKey);
      if (terminalKey) recovery.keys.add(terminalKey);
      void perform(ctx, 'reconcile');
    } catch (failure) { update(ctx, { error: failure.message }); }
  }, [controlState, sessionId, scopeSignal, store, active, saved.pending?.body.requestId, saved.pending?.receipt?.status, saved.isSending]);

  async function stopConversation() {
    const ctx = scope.current, now = latestProps.current;
    if (!ctx || !current(ctx) || ctx.remote || now.readOnly || !now.onStopConversation || now.isStopping || view.localStopping) return;
    update(ctx, { localStopping: true, stopFailure: '' });
    try {
      const receipt = await now.onStopConversation();
      if (!current(ctx)) return;
      if (receipt?.status !== 'cancelled' || receipt.cleanupConfirmed !== true) throw new Error('Stop cleanup could not be confirmed. Check conversation health and retry Stop if needed.');
      // Session Stop confirms cleanup only. It cannot settle the exact command.
      ctx.healthBarrier = false; update(ctx, { healthBarrier: false });
      if (ctx.store.getSnapshot().pending) await perform(ctx, 'reconcile');
      await reloadContext(ctx);
    } catch (failure) { ctx.healthBarrier = true; update(ctx, { healthBarrier: true, stopFailure: failure.message || 'Stop could not be confirmed.' }); }
    finally { update(ctx, { localStopping: false }); }
  }

  const ctx = scope.current, visible = Boolean(active && ctx && ctx.sessionId === sessionId && ctx.environmentSignal === scopeSignal && view.token === ctx);
  const context = visible ? view.context : null;
  const outcome = saved.lastCommand?.outcome || null;
  return { context, loading: visible ? view.loading : Boolean(active), instructions: saved.instructions, pending: saved.pending, outcome,
    error: visible ? saved.error || view.error : '', storeError: visible ? saved.error : '', stopFailure: visible ? view.stopFailure : '',
    isSubmitting: saved.isSending, isStopping: Boolean(props.isStopping || (visible && view.localStopping)),
    requiresCleanup: Boolean(props.requiresCleanup || (visible && view.healthBarrier) || context?.blockedReason === 'cleanup_required'),
    sampleStale: Boolean(visible && isStale(ctx)), canSubmit: Boolean(visible && !view.loading && !saved.isSending && canSubmitNow(ctx)),
    missingDetailsMessage: outcome?.detailsUnavailable ? terminalDetailsMissing : '',
    setInstructions: store.setInstructions, retrySave: store.retrySave, submit: () => perform(scope.current, 'submit'), retry: () => perform(scope.current, 'retry'), reconcile: () => perform(scope.current, 'reconcile'),
    reload: () => { const context = scope.current; update(context, { error: '' }); return reloadContext(context); }, stopConversation };
}
