import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { clearThreadTerminalRecovery, newThreadTerminalRecovery, readThreadTerminalRecovery, sharedThreadTerminalOperationId, subscribeThreadTerminalRecovery, threadTerminalRecoveryKey, writeThreadTerminalRecovery } from '../utils/threadTerminalRecovery';

const authSnapshot = () => JSON.stringify(captureAuthScope());
const sameFailure = (left, right) => left.threadId === right.threadId && left.signal === right.signal
  && left.authKey === right.authKey && left.kind === right.kind
  && (left.kind !== 'restore' || left.terminalId === right.terminalId);
function creationErrorMessage(failure) {
  const message = typeof failure?.message === 'string' ? failure.message.trim() : '';
  if (!message) return 'Could not open a terminal for this thread.';
  if (message.length <= 240) return message;
  const prefix = message.slice(0, 239);
  return `${/[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix}…`;
}

// T3-style terminal drawer: hidden PTYs that belong to one conversation, opened in its folder.
export function useThreadDrawerTerminal({ threadId, cwd, open, active = true, enabled = true, sessions, createSession, updateThreadMetadata, restoreSession }) {
  const [created, setCreated] = useState([]);
  const [selected, setSelected] = useState(null);
  const [failures, setFailures] = useState([]);
  const [dismissedRecovery, setDismissedRecovery] = useState(null);
  const recordFailure = useCallback(next => setFailures(current => [...current.filter(item => !sameFailure(item, next)), next]), []);
  const clearFailure = useCallback(target => setFailures(current => current.filter(item => !sameFailure(item, target))), []);
  const attemptRef = useRef(new Map());
  const freshOperationRef = useRef(false);
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const authKey = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  const [, setRecoveryVersion] = useState(0);
  const recoveryKey = useMemo(() => threadId ? threadTerminalRecoveryKey(captureAuthScope(), threadId) : null, [authKey, signal, threadId]);
  useEffect(() => recoveryKey ? subscribeThreadTerminalRecovery(recoveryKey, () => setRecoveryVersion(value => value + 1)) : undefined, [recoveryKey]);
  let recovery = { raw: null, record: null }, recoveryReadError = '';
  try { if (recoveryKey) recovery = readThreadTerminalRecovery(recoveryKey, threadId); }
  catch { recoveryReadError = 'Saved terminal recovery could not be read. Review this tab’s saved data before opening a terminal.'; }
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const scope = useRef({ signal, authKey, threadId, blocked: false });
  if (scope.current.signal !== signal || scope.current.authKey !== authKey) {
    scope.current = { signal, authKey, threadId, blocked: open };
  } else if (scope.current.blocked && (!open || scope.current.threadId !== threadId)) {
    scope.current.blocked = false;
  }
  const scopeBlocked = scope.current.blocked;

  const terminals = useMemo(() => {
    const listed = (sessions || []).filter(session => threadId && session?.thread?.companionOf === threadId);
    const extra = created.filter(item => item.threadId === threadId && item.signal === signal && item.authKey === authKey && !listed.some(session => session.id === item.id)).map(item => ({ id: item.id }));
    return [...listed].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))).concat(extra);
  }, [authKey, created, sessions, signal, threadId]);

  const create = useCallback(async () => {
    const freshOperation = freshOperationRef.current;
    freshOperationRef.current = false;
    if (!open || !active || !enabled || !threadId || !cwd || scopeBlocked) return null;
    const previous = attemptRef.current.get(threadId);
    if (previous?.pending && previous.signal === signal && previous.authKey === authKey) return null;
    const sameScope = previous?.signal === signal && previous.authKey === authKey && previous.cwd === cwd;
    let saved;
    try { saved = readThreadTerminalRecovery(recoveryKey, threadId); }
    catch { recordFailure({ threadId, signal, authKey, kind: 'create', message: 'Saved terminal recovery could not be read. Review this tab’s saved data before opening a terminal.' }); return null; }
    if (saved.record?.cwd !== undefined && saved.record.cwd !== cwd) return null;
    if (saved.record?.phase === 'creating') { setDismissedRecovery(null); return null; }
    const candidate = saved.record?.phase === 'created' ? (sessions || []).find(item => item?.id === saved.record.terminalId) : null;
    const remembered = sameScope && previous.session?.id === saved.record?.terminalId;
    if (saved.record?.phase === 'created' && !remembered && (!candidate || candidate.cwd !== saved.record.terminalCwd
      || (candidate.thread?.companionOf && candidate.thread.companionOf !== threadId))) return null;
    const attempt = { pending: true, signal, authKey, cwd, auth: captureAuthScope(), session: remembered ? previous.session : candidate || null,
      operationId: saved.record?.operationId, raw: saved.raw, recovered: Boolean(saved.record && !remembered) };
    attemptRef.current.set(threadId, attempt);
    const failureScope = { threadId, signal, authKey, kind: 'create' };
    clearFailure(failureScope);
    try {
      if (!saved.record) {
        const intent = newThreadTerminalRecovery(threadId, cwd, freshOperation || terminals.length ? undefined : sharedThreadTerminalOperationId(attempt.auth, threadId));
        attempt.operationId = intent.operationId;
        try { attempt.raw = writeThreadTerminalRecovery(recoveryKey, null, intent); }
        catch { throw new Error('Terminal recovery could not be saved on this device. Check storage before opening a terminal.'); }
      }
      const session = attempt.session || await createSession({ cwd, title: terminals.length ? `Terminal ${terminals.length + 1}` : 'Terminal', select: false, requestId: attempt.operationId, companionOf: threadId });
      if (!session?.id) throw new Error('The terminal could not be created.');
      attempt.session = session;
      if (signal.aborted || !isAuthScopeCurrent(attempt.auth)) return null;
      if (!saved.record) {
        const confirmed = { ...JSON.parse(attempt.raw), phase: 'created', terminalId: session.id, terminalCwd: session.cwd || cwd };
        try { attempt.raw = writeThreadTerminalRecovery(recoveryKey, attempt.raw, confirmed); }
        catch { throw new Error('The terminal was created, but recovery could not be saved. Check the terminal list before trying again.'); }
      }
      // A server that honours the request id links the terminal in the same write that creates it.
      const linkedAtCreation = session.companionOf === threadId && session.requestId === attempt.operationId;
      if (!linkedAtCreation && !enabledRef.current) {
        recordFailure({ ...failureScope, message: 'Terminal access changed before it could be linked. Retry when access is restored.' });
        return null;
      }
      const linked = linkedAtCreation ? { companionOf: threadId } : await updateThreadMetadata?.(session.id, { companionOf: threadId });
      if (signal.aborted || !isAuthScopeCurrent(attempt.auth)) return null;
      if (linked?.companionOf !== threadId) throw new Error('The terminal link could not be confirmed. Check the terminal list before retrying.');
      clearThreadTerminalRecovery(recoveryKey, attempt.raw);
      attempt.session = null;
      setCreated(current => [...current, { threadId, id: session.id, signal, authKey }]);
      if (currentThread.current === threadId) setSelected(session.id);
      return session.id;
    } catch (failure) {
      if (!signal.aborted && isAuthScopeCurrent(attempt.auth)) recordFailure({ ...failureScope, message: creationErrorMessage(failure) });
      return null;
    } finally {
      attempt.pending = false;
    }
  }, [active, authKey, clearFailure, createSession, cwd, enabled, open, recordFailure, recoveryKey, scopeBlocked, sessions, signal, terminals.length, threadId, updateThreadMetadata]);

  useEffect(() => {
    const previous = attemptRef.current.get(threadId);
    if (!open || !active || !enabled || scopeBlocked || !threadId || !cwd || recoveryReadError || recovery.record || terminals.length || (previous?.signal === signal && previous.authKey === authKey)) return;
    create();
  }, [active, authKey, open, enabled, threadId, cwd, recovery.raw, recoveryReadError, scopeBlocked, signal, terminals.length, create]);

  useEffect(() => {
    const record = recovery.record;
    if (!record || record.phase !== 'created' || record.cwd !== cwd || signal.aborted) return;
    if (attemptRef.current.get(threadId)?.pending && attemptRef.current.get(threadId)?.operationId === record.operationId) return;
    const linked = (sessions || []).find(item => item?.id === record.terminalId && item.cwd === record.terminalCwd && item.thread?.companionOf === threadId);
    if (!linked) return;
    try { clearThreadTerminalRecovery(recoveryKey, recovery.raw); } catch { /* Another attempt changed the marker; leave it for review. */ }
  }, [cwd, recovery.raw, recoveryKey, sessions, signal, threadId]);

  const terminalId = terminals.some(item => item.id === selected) ? selected : terminals[0]?.id || null;
  // A shell that ended (for example when the server restarted) starts again in the same terminal, keeping its history.
  const restoredRef = useRef(new Map());
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const terminalActive = terminals.find(item => item.id === terminalId)?.isActive;
  const available = open && enabled && !scopeBlocked && Boolean(threadId && cwd);
  const ended = available && active && terminalActive === false;
  useEffect(() => {
    if (terminalActive !== true || !terminalId) return;
    clearFailure({ threadId, terminalId, signal, authKey, kind: 'restore' });
    const previous = restoredRef.current.get(terminalId);
    if (previous?.signal !== signal || previous.authKey !== authKey) return;
    if (previous.pending) previous.observedActive = true;
    else restoredRef.current.delete(terminalId);
  }, [authKey, clearFailure, signal, terminalActive, terminalId, threadId]);
  const restore = useCallback(async (id, retry = false) => {
    const previous = restoredRef.current.get(id);
    if (previous?.signal === signal && previous.authKey === authKey && (!retry || previous.pending)) return;
    const auth = captureAuthScope();
    const attempt = { signal, authKey, pending: true };
    restoredRef.current.set(id, attempt);
    const failureScope = { threadId, terminalId: id, signal, authKey, kind: 'restore' };
    clearFailure(failureScope);
    try {
      const result = await restoreSession(id, { automatic: true, select: false });
      if (result?.restored === false) throw new Error('Terminal restoration was not confirmed');
    } catch {
      if (!attempt.observedActive && !signal.aborted && isAuthScopeCurrent(auth)) recordFailure({ ...failureScope, message: 'This terminal could not be restarted.' });
    } finally {
      attempt.pending = false;
      if (attempt.observedActive && restoredRef.current.get(id) === attempt) {
        restoredRef.current.delete(id);
        setRestoreEpoch(value => value + 1);
      }
    }
  }, [authKey, clearFailure, recordFailure, restoreSession, signal, threadId]);
  useEffect(() => {
    if (!ended || !restoreSession) return;
    void restore(terminalId);
  }, [ended, restore, restoreEpoch, restoreSession, terminalId]);
  const matchingFailures = failures.filter(failure => failure.threadId === threadId && failure.signal === signal && failure.authKey === authKey);
  const createFailure = matchingFailures.find(failure => failure.kind === 'create') || null;
  const applicableFailure = matchingFailures.find(failure => failure.kind === 'restore' && failure.terminalId === terminalId)
    || (!terminalId ? createFailure : null);
  const inFlight = attemptRef.current.get(threadId)?.pending && attemptRef.current.get(threadId)?.operationId === recovery.record?.operationId;
  const pendingRecovery = !inFlight && recovery.record;
  const candidate = pendingRecovery?.phase === 'created' ? (sessions || []).find(item => item?.id === pendingRecovery.terminalId) : null;
  const rememberedAttempt = attemptRef.current.get(threadId);
  const remembered = rememberedAttempt?.signal === signal && rememberedAttempt.authKey === authKey && rememberedAttempt.cwd === cwd
    && rememberedAttempt.session?.id === pendingRecovery?.terminalId;
  const canRecoverLink = pendingRecovery?.phase === 'created' && pendingRecovery.cwd === cwd && (remembered || (candidate?.cwd === pendingRecovery.terminalCwd
    && (!candidate.thread?.companionOf || candidate.thread.companionOf === threadId)));
  const recoveryMessage = recoveryReadError || (pendingRecovery?.cwd !== undefined && pendingRecovery.cwd !== cwd
    ? 'The workspace changed while terminal creation was unconfirmed. Check the original terminal list before continuing.'
    : pendingRecovery?.phase === 'creating'
      ? `${createFailure?.message ? `${Array.from(createFailure.message).slice(0, 80).join('')}${Array.from(createFailure.message).length > 80 ? '…' : ''} ` : ''}A terminal may already exist from an unconfirmed request. Check the terminal list before starting another; the earlier request may still finish.`
      : pendingRecovery?.phase === 'created'
        ? canRecoverLink ? remembered && createFailure ? createFailure.message : 'A terminal was created but its link was not confirmed. Check the terminal list, then retry linking.' : 'A created terminal could not be verified in this workspace. Check the terminal list before continuing.'
        : '');
  const error = scopeBlocked ? 'The account or environment changed. Close and reopen the terminal.' : !terminalId && recoveryMessage ? recoveryMessage : applicableFailure?.message || '';
  const retry = () => !terminalId && pendingRecovery?.phase === 'created' ? create() : applicableFailure?.kind === 'restore' && restoreSession ? restore(terminalId, true) : create();
  const startAgainAfterReview = async () => {
    if (!available || !active || !pendingRecovery || !recoveryKey) return null;
    try { clearThreadTerminalRecovery(recoveryKey, recovery.raw); }
    catch { recordFailure({ threadId, signal, authKey, kind: 'create', message: 'Terminal recovery changed. Review it before continuing.' }); return null; }
    attemptRef.current.delete(threadId);
    clearFailure({ threadId, signal, authKey, kind: 'create' });
    freshOperationRef.current = true;
    return create();
  };
  return {
    terminalId: available ? terminalId : null,
    terminals: available ? terminals : [],
    select: setSelected,
    addTerminal: create,
    retry,
    canRetry: Boolean(available && (pendingRecovery ? !terminalId && canRecoverLink : applicableFailure)),
    error,
    createError: available && terminalId && dismissedRecovery !== pendingRecovery?.operationId ? recoveryMessage || createFailure?.message || '' : '',
    retryCreate: create,
    canRetryCreate: Boolean(available && (pendingRecovery ? canRecoverLink : createFailure)),
    dismissCreateError: () => { setDismissedRecovery(pendingRecovery?.operationId || null); clearFailure({ threadId, signal, authKey, kind: 'create' }); },
    canStartAgainAfterReview: Boolean(available && pendingRecovery && (!canRecoverLink || pendingRecovery.phase === 'creating')),
    startAgainAfterReview,
  };
}
