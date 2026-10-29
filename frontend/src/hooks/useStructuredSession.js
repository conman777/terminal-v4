import { environmentAllows } from '../utils/runtimePermissions';
import { getActiveEnvironment, getEnvironmentCacheScope, getEnvironmentSignal, getEnvironmentStorage, subscribeEnvironment } from '../utils/remoteEnvironments';
import { createTerminalReconnectController, isPermanentSocketClose } from '../utils/terminalSocketReconnect';
import { resolveWebSocketUrl } from '../utils/apiBase';
import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { useComposerDraft } from './useComposerDraft';
import { cloneImageAttachments } from '../utils/userImageInput';
import { runNativeImageMessage } from '../utils/nativeImageMessage';
import { getAccessToken, isAccessTokenExpired, refreshTokens, captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';
import { createApprovalIntentStore } from '../utils/approvalIntentStore';
import { supervisedInputTransaction } from '../utils/supervisedInputTransaction';

function matchesToolCall(tool, event) {
  const sameCall = event.toolCallId ? tool.toolCallId === event.toolCallId : !tool.toolCallId && tool.toolName === event.toolName;
  return sameCall && (!event.turnId || !tool.turnId || event.turnId === tool.turnId);
}

function insertMessage(messages, message, fallbackIndex = messages.length) {
  const nextIndex = Number.isSafeInteger(message.seq)
    ? messages.findIndex(existing => Number.isSafeInteger(existing.seq) && existing.seq > message.seq)
    : fallbackIndex;
  const index = nextIndex < 0 ? messages.length : nextIndex;
  return [...messages.slice(0, index), message, ...messages.slice(index)];
}

function mergeUserMessage(messages, message, insertAt = messages.length) {
  const index = messages.findIndex(existing => existing.role === 'user' && (
    (message.requestId && existing.requestId === message.requestId)
    || (message.messageId && existing.messageId === message.messageId)
  ));
  if (index >= 0) return messages.map((existing, position) => position === index ? {
    ...existing, ...message,
    ...(Number.isSafeInteger(existing.seq) && Number.isSafeInteger(message.seq) ? { seq: Math.min(existing.seq, message.seq) } : {}),
  } : existing);
  return insertMessage(messages, { ts: Date.now(), ...message }, insertAt);
}

function isAcceptedReceipt(receipt, requestId) {
  return receipt?.requestId === requestId && typeof receipt.turnId === 'string' && Boolean(receipt.turnId)
    && typeof receipt.messageId === 'string' && Boolean(receipt.messageId)
    && Number.isSafeInteger(receipt.acceptedSeq) && receipt.acceptedSeq > 0
    && ['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'cleanup_required', 'reconciliation_required'].includes(receipt.status);
}

/**
 * Recognizes server states requiring explicit cleanup recovery.
 */
function cleanupRequired(status) { return ['cleanup_required', 'reconciliation_required'].includes(status); }

const CONTROL_FIELDS = {
  command_accepted: ['requestId', 'turnId', 'command', 'input'],
  compaction: ['turnId', 'status', 'receipt', 'message'],
  context_usage: ['turnId', 'usage'],
  turn_started: ['turnId'],
  turn_completed: ['turnId', 'status'],
};
// The agent's own thinking summaries and task plans, shown in the thread as it works.
const WORK_MESSAGE_ROLES = new Set(['reasoning', 'plan']);
const MAX_CONTROL_EVENTS = 64;
const MAX_CONTROL_BYTES = 256000;
const MAX_CONTROL_EVENT_BYTES = 64000;

function emptyControls(scope, generation = scope.generation) {
  return { scope, generation, latestSeq: 0, entries: [], bytes: 0, truncated: false };
}

function appendControl(previous, scope, event) {
  const next = previous.scope === scope ? previous : emptyControls(scope);
  if (!Number.isSafeInteger(event.seq) || event.seq <= next.latestSeq) return previous;
  const fields = Object.prototype.hasOwnProperty.call(CONTROL_FIELDS, event.type) ? CONTROL_FIELDS[event.type] : null;
  if (!fields) return { ...next, latestSeq: event.seq };
  const selected = { type: event.type };
  for (const field of ['ts', 'seq', ...fields]) {
    if (Object.prototype.hasOwnProperty.call(event, field)) selected[field] = event[field];
  }
  const size = new TextEncoder().encode(JSON.stringify(selected)).length;
  if (size > MAX_CONTROL_EVENT_BYTES) return { ...next, latestSeq: event.seq, truncated: true };
  const entries = [...next.entries, { event: selected, bytes: size }];
  let bytes = next.bytes + size;
  let truncated = next.truncated;
  while (entries.length > MAX_CONTROL_EVENTS || bytes + 2 + Math.max(0, entries.length - 1) > MAX_CONTROL_BYTES) {
    bytes -= entries.shift().bytes;
    truncated = true;
  }
  return { ...next, latestSeq: event.seq, entries, bytes, truncated };
}

export function useStructuredSession({ sessionId, active = true, runtime, status, statusSeq = 0, aiType, model }) {
  const isV4 = runtime === 'v4';
  const hasReceipts = isV4 || runtime === 'codex';
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const controlGenerationRef = useRef(0);
  const controlScope = useMemo(() => ({ sessionId, runtime, signal: environmentSignal, generation: ++controlGenerationRef.current }), [sessionId, runtime, environmentSignal]);
  const controlScopeRef = useRef(controlScope);
  controlScopeRef.current = controlScope;
  // Image selection has its own render-time epoch. Model ABA retires an action
  // without resetting the conversation, shared socket or canonical transcript.
  const imageSelectionGenerationRef = useRef(0);
  const imageSelection = useMemo(() => ({ aiType, model, generation: ++imageSelectionGenerationRef.current }), [aiType, model]);
  const imageSelectionRef = useRef(imageSelection); imageSelectionRef.current = imageSelection;

  const [controlProjection, setControlProjection] = useState(() => emptyControls(controlScope));
  const resetControls = useCallback(() => {
    if (controlScopeRef.current !== controlScope || controlScope.signal.aborted) return;
    setControlProjection(emptyControls(controlScope, ++controlGenerationRef.current));
  }, [controlScope]);
  const controlState = useMemo(() => {
    const current = isV4 && controlProjection.scope === controlScope && !environmentSignal.aborted
      ? controlProjection : emptyControls(controlScope);
    return { sessionId, generation: current.generation, latestSeq: current.latestSeq,
      events: current.entries.map(entry => entry.event), truncated: current.truncated };
  }, [sessionId, isV4, controlProjection, controlScope, environmentSignal]);
  const { store: composerStore, isSending: sharedIsSending } = useComposerDraft(hasReceipts ? sessionId : null);
  const [contextUsage, setContextUsage] = useState(null);
  const [messages, setMessages] = useState([]);
  const [currentToolCalls, setCurrentToolCalls] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [requiresCleanup, setRequiresCleanup] = useState(() => hasReceipts && cleanupRequired(status));
  const cleanupSeqRef = useRef(0);
  const cleanupRequiredRef = useRef(requiresCleanup);
  cleanupRequiredRef.current = requiresCleanup;
  const [connectionState, setConnectionState] = useState('connecting');
  const [isSending, setIsSending] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [controlError, setControlError] = useState('');
  const [transportError, setTransportError] = useState('');
  const historyOnlyRef = useRef(null);
  const [historyOnlyScope, setHistoryOnlyScope] = useState(null);
  const [sendError, setSendError] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const pendingApprovalRef = useRef(null);
  const approvalStore = useCallback(() => {
    const auth = captureAuthScope(), cache = getEnvironmentCacheScope();
    const expected = auth.userId ? `identity:${encodeURIComponent(new URL(auth.home).origin)}:${encodeURIComponent(auth.userId)}:` : '';
    if (!sessionId || !expected || cache.identity !== expected) throw new Error('Approval recovery scope is unavailable.');
    const current = () => controlScopeRef.current === controlScope && !controlScope.signal.aborted && isAuthScopeCurrent(auth);
    return createApprovalIntentStore(getEnvironmentStorage(), supervisedInputTransaction, current, sessionId);
  }, [sessionId, controlScope]);
  useEffect(() => {
    if (runtime !== 'codex' || !sessionId) return undefined;
    const changed = event => {
      if (!event.key?.endsWith(`approvalDecision:v1:${encodeURIComponent(sessionId)}`)) return;
      try {
        const saved = approvalStore().read();
        if (!saved) return;
        const previous = pendingApprovalRef.current;
        const action = previous?.approvalId === saved.approvalId ? previous : { approvalId: saved.approvalId, toolName: 'Unknown action', description: 'A previous approval needs review. Check the conversation history.' };
        const unconfirmed = { ...action, decisionUnconfirmed: true, reviewUnavailable: saved.mode === 'legacy' };
        pendingApprovalRef.current = unconfirmed; setPendingApproval(unconfirmed);
      } catch {
        const previous = pendingApprovalRef.current;
        if (previous) { const unconfirmed = { ...previous, decisionUnconfirmed: true }; pendingApprovalRef.current = unconfirmed; setPendingApproval(unconfirmed); }
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [runtime, sessionId, approvalStore]);
  const currentToolCallsRef = useRef([]);
  const activeTurnRef = useRef(null);
  const legacySessionRunningRef = useRef(false);
  const completedTurnsRef = useRef(new Set());
  const sendRequestRef = useRef(null);
  const approvalRequestRef = useRef(null);
  const interruptRequestRef = useRef(null);
  const actionGenerationRef = useRef(0);
  const [windowActive, setWindowActive] = useState(() => isWindowActive());
  const wsRef = useRef(null);
  const reconnectControllerRef = useRef(null);
  const environmentSignalRef = useRef(environmentSignal);
  // Optional legacy adapters retire on a scope abort and reconnect only after remount.
  if (hasReceipts) environmentSignalRef.current = environmentSignal;
  const connectRef = useRef(null);
  const isConnectingRef = useRef(false);
  const windowActiveRef = useRef(windowActive);
  const lastSeqRef = useRef(0);
  const isReconnectRef = useRef(false);
  const socketScopeRef = useRef(null);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const reconnect = useCallback(() => {
    if (!active || !sessionId || controlScopeRef.current !== controlScope || environmentSignal.aborted) return;
    setReconnectRevision(revision => revision + 1);
  }, [active, sessionId, controlScope, environmentSignal]);

  useEffect(() => subscribeWindowActivity(setWindowActive), []);
  useEffect(() => {
    windowActiveRef.current = windowActive;
  }, [windowActive]);

  useEffect(() => {
    actionGenerationRef.current += 1;
    cleanupSeqRef.current = Number.isSafeInteger(statusSeq) ? statusSeq : 0;
    cleanupRequiredRef.current = hasReceipts && cleanupRequired(status);
    setRequiresCleanup(cleanupRequiredRef.current);
    setIsSending(false); setIsApproving(false); setIsInterrupting(false); setSendError(''); setApprovalError(''); setControlError('');
    setMessages([]); setPendingApproval(null); pendingApprovalRef.current = null;
    activeTurnRef.current = null;
    legacySessionRunningRef.current = false;
    currentToolCallsRef.current = []; setCurrentToolCalls([]);
    return () => {
      actionGenerationRef.current += 1;
      sendRequestRef.current?.controller.abort();
      sendRequestRef.current?.store?.releaseSend(sendRequestRef.current.lease);
      approvalRequestRef.current?.controller.abort();
      interruptRequestRef.current?.controller.abort();
      sendRequestRef.current = null; approvalRequestRef.current = null; interruptRequestRef.current = null;
    };
  }, [sessionId, runtime, environmentSignal]);

  useEffect(() => {
    if (!hasReceipts || !status) return;
    const seq = Number.isSafeInteger(statusSeq) ? statusSeq : 0;
    if (seq < cleanupSeqRef.current) return;
    cleanupSeqRef.current = seq;
    cleanupRequiredRef.current = cleanupRequired(status);
    setRequiresCleanup(cleanupRequiredRef.current);
  }, [sessionId, hasReceipts, status, statusSeq]);

  const processEvent = useCallback((event) => {
    if (controlScopeRef.current !== controlScope || controlScope.signal.aborted) return;
    if (event.type === 'context_usage' && event.usage && typeof event.usage === 'object') setContextUsage({ sessionId, usage: event.usage });
    if (isV4 && Number.isSafeInteger(event.seq) && event.seq > 0) {
      setControlProjection(previous => controlScopeRef.current === controlScope && !controlScope.signal.aborted
        ? appendControl(previous, controlScope, event) : previous);
    }
    const messageIdentity = {
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(hasReceipts && Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
    };
    const updateTools = tools => { currentToolCallsRef.current = tools; setCurrentToolCalls(tools); };
    const updateCleanup = required => {
      if (!hasReceipts || (Number.isSafeInteger(event.seq) && event.seq <= cleanupSeqRef.current)) return;
      if (Number.isSafeInteger(event.seq)) cleanupSeqRef.current = event.seq;
      cleanupRequiredRef.current = required; setRequiresCleanup(required);
      if (!required) setControlError('');
    };
    switch (event.type) {
      case 'session_started':
        if (!hasReceipts) legacySessionRunningRef.current = true;
        if (!isV4) setIsStreaming(true);
        break;
      case 'session_ended':
        legacySessionRunningRef.current = false;
        setIsStreaming(false); activeTurnRef.current = null;
        if (!pendingApprovalRef.current?.decisionUncertain && !pendingApprovalRef.current?.decisionUnconfirmed) { pendingApprovalRef.current = null; setPendingApproval(null); }
        updateTools([]);
        break;
      case 'user_message_accepted': {
        if (runtime === 'codex' && event.turnId) { activeTurnRef.current = event.turnId; setIsStreaming(true); }
        let images = null;
        try {
          if (Object.prototype.hasOwnProperty.call(event, 'attachments')) {
            // An empty optional vector is a text message. All nonempty or
            // non-array values must validate before React evaluates an updater.
            if (!Array.isArray(event.attachments) || event.attachments.length) images = cloneImageAttachments(event.attachments);
          }
        } catch {
          setSendError('Image message metadata could not be read. Your draft and request identity were kept. Reconnect to recover the conversation.');
          break;
        }
        setMessages(previous => mergeUserMessage(previous, {
          role: 'user', content: event.content, ...messageIdentity,
          ...(images ? { attachments: images } : {}),
          ...(event.requestId ? { requestId: event.requestId } : {}),
          ...(event.ts !== undefined ? { ts: event.ts } : {}),
        }));
        break;
      }
      case 'command_accepted':
        if (isV4 && event.command === 'compact' && typeof event.turnId === 'string' && event.turnId
          && Number.isSafeInteger(event.seq) && event.seq > 0) {
          activeTurnRef.current = event.turnId; setIsStreaming(true);
        }
        break;
      case 'turn_started':
        activeTurnRef.current = event.turnId; setIsStreaming(true);
        break;
      case 'turn_completed':
        if (hasReceipts && typeof event.turnId === 'string' && event.turnId) {
          if (runtime === 'codex') completedTurnsRef.current.add(event.turnId);
          const completionStatus = ['cancelled', 'interrupted', 'failed'].includes(event.status) ? event.status : 'unconfirmed';
          setMessages(previous => previous.map(message => message.turnId === event.turnId && message.streaming
            ? (message.role === 'assistant' ? { ...message, streaming: false, completionStatus } : { ...message, streaming: false }) : message));
        }
        if (!activeTurnRef.current || activeTurnRef.current === event.turnId) {
          activeTurnRef.current = null; setIsStreaming(false);
          if (!isV4) {
            updateTools([]);
            if (pendingApprovalRef.current?.turnId === event.turnId && !pendingApprovalRef.current?.decisionUncertain && !pendingApprovalRef.current?.decisionUnconfirmed) {
              pendingApprovalRef.current = null; setPendingApproval(null);
            }
          }
          if (!isV4) setMessages(previous => previous.map(message => message.turnId === event.turnId ? { ...message, streaming: false } : message));
        }
        break;
      case 'message_started':
        setIsStreaming(true);
        if (event.role === 'assistant' && event.messageId) setMessages(previous => previous.some(message => message.messageId === event.messageId) ? previous : insertMessage(previous, { role: 'assistant', content: '', ts: event.ts, streaming: true, ...(isV4 ? { completionStatus: 'streaming' } : {}), ...messageIdentity }));
        break;
      case 'message_delta':
      case 'message_completed': {
        const completed = event.type === 'message_completed';
        if (event.role === 'assistant') {
          setMessages(previous => {
            const index = event.messageId
              ? previous.findIndex(message => message.role === 'assistant' && message.messageId === event.messageId)
              : previous.length - 1;
            const existing = previous[index];
            const matches = existing?.role === 'assistant' && (event.messageId || existing.streaming);
            const next = {
              ...(matches ? existing : {}), role: 'assistant',
              content: completed ? event.content : (matches ? existing.content : '') + event.content,
              ts: event.ts, streaming: !completed, ...messageIdentity,
              ...(isV4 ? { completionStatus: completed ? 'completed' : 'streaming' } : {}),
              ...(matches && Number.isSafeInteger(existing.seq) ? { seq: existing.seq } : {}),
            };
            return matches ? previous.map((message, position) => position === index ? next : message) : insertMessage(previous, next);
          });
          if (!completed) setIsStreaming(true);
          else if (!hasReceipts && !legacySessionRunningRef.current) setIsStreaming(false);
        } else if (WORK_MESSAGE_ROLES.has(event.role) && event.messageId) {
          setMessages(previous => {
            const index = previous.findIndex(message => message.role === event.role && message.messageId === event.messageId);
            const existing = previous[index];
            const next = {
              ...existing, role: event.role,
              content: completed ? event.content : (existing?.content || '') + event.content,
              ts: existing?.ts ?? event.ts, streaming: !completed, ...messageIdentity,
              ...(existing && Number.isSafeInteger(existing.seq) ? { seq: existing.seq } : {}),
            };
            return existing ? previous.map((message, position) => position === index ? next : message) : insertMessage(previous, next);
          });
        } else if (event.role === 'user' && completed) {
          setMessages(previous => {
            const pending = !hasReceipts ? previous.findIndex(message => message.legacyPending && message.content === event.content) : -1;
            if (pending >= 0) return previous.map((message, index) => index === pending
              ? { role: 'user', content: event.content, ts: event.ts, ...messageIdentity } : message);
            return mergeUserMessage(previous, { role: 'user', content: event.content, ts: event.ts, ...messageIdentity });
          });
        }
        break;
      }
      case 'tool_started': {
        const tool = { toolName: event.toolName, toolInput: event.toolInput, toolCallId: event.toolCallId, turnId: event.turnId, seq: event.seq, status: 'running', result: null };
        updateTools([...currentToolCallsRef.current.filter(existing => !event.toolCallId || !matchesToolCall(existing, event)), tool]);
        break;
      }
      case 'tool_output':
        updateTools(currentToolCallsRef.current.map(tool => matchesToolCall(tool, event) ? { ...tool, result: (tool.result || '') + event.output } : tool));
        break;
      case 'tool_completed': {
        const tool = currentToolCallsRef.current.find(existing => matchesToolCall(existing, event));
        updateTools(currentToolCallsRef.current.filter(existing => existing !== tool));
        if (tool) setMessages(previous => event.toolCallId && previous.some(message => message.role === 'tool' && matchesToolCall(message, event)) ? previous : insertMessage(previous, {
          role: 'tool', toolName: tool.toolName, toolInput: tool.toolInput,
          toolCallId: event.toolCallId, turnId: event.turnId ?? tool.turnId,
          result: event.result, isError: event.isError, ts: event.ts,
          ...(Array.isArray(event.content) ? { content: event.content } : {}),
          ...(isV4 ? { seq: tool.seq } : {}),
        }));
        break;
      }
      case 'approval_required':
      case 'input_required': {
        const approval = event.type === 'input_required'
          ? { type: 'input', prompt: event.prompt, ts: event.ts, seq: event.seq }
          : { toolName: event.toolName, toolInput: event.toolInput, description: event.description,
            ts: event.ts, seq: event.seq, approvalId: event.approvalId, turnId: event.turnId,
            toolCallId: event.toolCallId, expiresAt: event.expiresAt };
        if (runtime === 'codex' && approval.approvalId) {
          try {
            const saved = approvalStore().read();
            if (saved && saved.approvalId !== approval.approvalId) {
              const unresolved = { approvalId: saved.approvalId, toolName: 'Unknown action', description: 'A previous approval needs review. Check the conversation history.', decisionUnconfirmed: true };
              pendingApprovalRef.current = unresolved; setPendingApproval(unresolved);
              break;
            }
            if (saved) { approval.decisionUnconfirmed = true; approval.reviewUnavailable = saved.mode === 'legacy'; }
          } catch { approval.decisionUnconfirmed = true; }
        }
        const prior = pendingApprovalRef.current;
        if (runtime === 'codex' && (prior?.decisionUncertain || prior?.decisionUnconfirmed)) {
          if (prior.approvalId !== approval.approvalId || (prior.turnId || '') !== (approval.turnId || '')) break;
          const enriched = { ...prior, ...approval, decisionUncertain: prior.decisionUncertain, decisionUnconfirmed: prior.decisionUnconfirmed, approved: prior.approved, forSession: prior.forSession };
          pendingApprovalRef.current = enriched; setPendingApproval(enriched);
          break;
        }
        pendingApprovalRef.current = approval;
        setPendingApproval(approval); setApprovalError('');
        break;
      }
      case 'approval_decision_reserved': {
        const approval = pendingApprovalRef.current;
        if (runtime === 'codex' && typeof event.approvalId === 'string' && event.approvalId && typeof event.reservationId === 'string' && event.reservationId) {
          const matches = approval?.approvalId === event.approvalId && (approval?.turnId || '') === (event.turnId || '');
          const action = matches ? approval : { approvalId: event.approvalId, turnId: event.turnId, toolName: 'Unknown action', description: 'Action details are unavailable. Check the conversation history before acknowledging.' };
          const reserved = { ...action, decisionUnconfirmed: true, reservationId: event.reservationId };
          pendingApprovalRef.current = reserved; setPendingApproval(reserved); setApprovalError('');
        }
        break;
      }
      case 'approval_decision_started': {
        const approval = pendingApprovalRef.current;
        if (runtime === 'codex' && typeof event.approvalId === 'string' && event.approvalId && typeof event.approved === 'boolean') {
          const matches = approval?.approvalId === event.approvalId && (approval?.turnId || '') === (event.turnId || '');
          const action = matches ? approval : { approvalId: event.approvalId, turnId: event.turnId, toolName: 'Unknown action', description: 'Action details are unavailable. Check the conversation history before acknowledging.' };
          const uncertain = { ...action, decisionUncertain: true, decisionUnconfirmed: false, approved: event.approved, forSession: event.forSession === true };
          pendingApprovalRef.current = uncertain; setPendingApproval(uncertain); setApprovalError('');
        }
        break;
      }
      case 'approval_decision_reviewed':
      case 'approval_resolved':
        if (runtime === 'codex' && event.approvalId) {
          try { void approvalStore().clear(event.approvalId).catch(() => setApprovalError('Approval recovery could not be cleared. Reopen the conversation to check it.')); }
          catch { setApprovalError('Approval recovery could not be cleared. Reopen the conversation to check it.'); }
        }
        if (event.approvalId && pendingApprovalRef.current?.approvalId === event.approvalId) {
          pendingApprovalRef.current = null; setPendingApproval(null); setApprovalError('');
        }
        break;
      case 'status':
        if (event.status === 'idle' || cleanupRequired(event.status)) updateCleanup(cleanupRequired(event.status));
        break;
      case 'error':
        if (['v4_cleanup_pending', 'codex_cleanup_pending'].includes(event.code)) updateCleanup(true);
        setMessages(previous => insertMessage(previous, { role: 'error', content: event.message, ts: event.ts, ...messageIdentity }));
        if (!hasReceipts) { legacySessionRunningRef.current = false; setIsStreaming(false); }
        break;
      default:
        break;
    }
  }, [isV4, hasReceipts, runtime, controlScope, sessionId, approvalStore]);

  useEffect(() => {
    if (!sessionId || !active) return;
    let disposed = false;
    let historyRecovery = null;
    const environmentSignal = environmentSignalRef.current;
    if (environmentSignal.aborted) return;
    const remote = Boolean(getActiveEnvironment());
    const resetModel = () => {
      resetControls();
      lastSeqRef.current = 0;
      isReconnectRef.current = false;
      setMessages([]);
      setCurrentToolCalls([]); currentToolCallsRef.current = []; activeTurnRef.current = null;
      legacySessionRunningRef.current = false;
      completedTurnsRef.current.clear();
      pendingApprovalRef.current = null;
      setPendingApproval(null);
      setIsStreaming(false);
    };
    if (socketScopeRef.current !== controlScope) {
      socketScopeRef.current = controlScope;
      resetModel();
      historyOnlyRef.current = null;
      setHistoryOnlyScope(null);
      setTransportError('');
    } else {
      isReconnectRef.current = true;
    }
    setConnectionState('connecting');

    const controller = createTerminalReconnectController(() => { void connect(); });
    reconnectControllerRef.current = controller;
    const stop = () => {
      historyRecovery?.abort();
      controller.stop();
      isConnectingRef.current = false;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
      if (!disposed) setConnectionState('unavailable');
    };
    environmentSignal.addEventListener('abort', stop, { once: true });

    async function recoverHistory() {
      historyOnlyRef.current = controlScope;
      setHistoryOnlyScope(controlScope);
      controller.stop();
      setConnectionState('unavailable');
      setIsStreaming(false);
      setTransportError('Live updates are paused because this response exceeds the connection limit. Loading saved history…');
      const scope = captureAuthScope();
      const abort = new AbortController();
      historyRecovery = abort;
      const current = () => !disposed && controlScopeRef.current === controlScope && !environmentSignal.aborted
        && !abort.signal.aborted && isAuthScopeCurrent(scope) && captureAuthScope().userId === scope.userId;
      const unsubscribe = subscribeAuth(() => { if (!isAuthScopeCurrent(scope) || captureAuthScope().userId !== scope.userId) abort.abort(); });
      const timeout = setTimeout(() => {
        if (current()) setTransportError('Saved history recovery timed out. Live updates are paused; check the connection and reload, or use a direct connection.');
        abort.abort();
      }, 15_000);
      const byteLimit = 20 * 1024 * 1024;
      let limited = false;
      try {
        const response = await apiFetch('/api/structured/sessions/' + encodeURIComponent(sessionId), { signal: abort.signal });
        if (!current()) return;
        if (!response.ok) throw new Error('History access failed');
        if (Number(response.headers.get('content-length')) > byteLimit) { limited = true;throw new Error('History limit reached'); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('History stream unavailable');
        abort.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
        let text = '';
        let bytes = 0;
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await reader.read();
            if (!current()) return;
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > byteLimit) { limited = true;throw new Error('History limit reached'); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          if (limited) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!current()) return;
        const snapshot = JSON.parse(text);
        if (snapshot.id !== sessionId || !Array.isArray(snapshot.events) || snapshot.events.length > 32768) throw new Error('Invalid saved history');
        let previous = 0;
        for (const event of snapshot.events) {
          if (!event || !Number.isSafeInteger(event.seq) || event.seq <= 0 || (previous && event.seq !== previous + 1)) throw new Error('Invalid history sequence');
          previous = event.seq;
        }
        resetModel();
        for (const event of snapshot.events) { lastSeqRef.current = event.seq;processEvent(event); }
        setIsStreaming(false);
        setTransportError('Saved history loaded; live updates are paused. Reload after upgrading the relay and host, or use a direct connection.');
      } catch {
        if (!disposed && !abort.signal.aborted && controlScopeRef.current === controlScope && !environmentSignal.aborted
          && isAuthScopeCurrent(scope) && captureAuthScope().userId === scope.userId) {
          setTransportError(limited
            ? 'Saved history exceeds the recovery limit. Live updates are paused; use a direct connection.'
            : 'Could not load saved history. Live updates are paused; check access and reload, or use a direct connection.');
        }
      } finally {
        clearTimeout(timeout);unsubscribe();abort.abort();
        if (historyRecovery === abort) historyRecovery = null;
      }
    }

    async function connect() {
      if (disposed || environmentSignal.aborted || controller.isStopped() || !windowActiveRef.current
        || isConnectingRef.current || wsRef.current) return;
      if (navigator.onLine === false) {
        controller.scheduleReconnect();
        return;
      }
      const attempt = controller.beginAttempt();
      isConnectingRef.current = true;
      let accessToken = getAccessToken();
      try {
        if (accessToken && isAccessTokenExpired(accessToken)) {
          accessToken = (await refreshTokens()).accessToken;
        }
      } catch (error) {
        if (!disposed && controller.isCurrentAttempt(attempt)) {
          isConnectingRef.current = false;
          if (['Token refresh failed', 'No refresh token', 'Invalid token response'].includes(error?.message)) stop();
          else controller.scheduleReconnect();
        }
        return;
      }
      if (disposed || environmentSignal.aborted || !controller.isCurrentAttempt(attempt)) return;
      if (!windowActiveRef.current || navigator.onLine === false) {
        isConnectingRef.current = false;
        return;
      }
      const params = new URLSearchParams();
      if (accessToken) params.set('token', accessToken);
      if (isReconnectRef.current && lastSeqRef.current > 0) params.set('last_seq', String(lastSeqRef.current));
      const ws = new WebSocket(resolveWebSocketUrl('/api/structured/sessions/' + encodeURIComponent(sessionId) + '/ws') + '?' + params.toString());
      wsRef.current = ws;
      isConnectingRef.current = false;
      const current = () => !disposed && controlScopeRef.current === controlScope && !environmentSignal.aborted && wsRef.current === ws && controller.isCurrentAttempt(attempt);
      ws.onopen = () => {
        if (!current()) return;
        controller.markConnected();
        setConnectionState('online');
        historyOnlyRef.current = null;
        setHistoryOnlyScope(null);
        setTransportError('');
      };
      ws.onmessage = event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (data.__terminal_meta && data.type === 'events_lost') {
            resetModel();
            ws.close();
            return;
          }
          if (data.__terminal_meta && data.type === 'structured_event' && data.event) {
            const seq = data.event.seq;
            if (Number.isSafeInteger(seq) && seq > 0) {
              if (seq <= lastSeqRef.current) return;
              if (lastSeqRef.current > 0 && seq > lastSeqRef.current + 1) {
                resetModel();
                ws.close();
                return;
              }
              lastSeqRef.current = seq;
            }
            processEvent(data.event);
          }
        } catch { /* Ignore malformed transport events. */ }
      };
      ws.onclose = (event = {}) => {
        if (!current()) return;
        wsRef.current = null;
        isConnectingRef.current = false;
        if (event.code === 1009) {
          void recoverHistory();
          return;
        }
        if (isPermanentSocketClose(event, remote)) {
          stop();
          return;
        }
        setConnectionState('offline');
        isReconnectRef.current = true;
        controller.scheduleReconnect();
      };
      ws.onerror = () => { if (current()) ws.close(); };
    }

    const offline = () => { wsRef.current?.close(); };
    window.addEventListener('offline', offline);
    connectRef.current = connect;
    void connect();

    return () => {
      disposed = true;
      historyRecovery?.abort();
      environmentSignal.removeEventListener('abort', stop);
      window.removeEventListener('offline', offline);
      controller.dispose();
      if (reconnectControllerRef.current === controller) reconnectControllerRef.current = null;
      connectRef.current = null;
      isConnectingRef.current = false;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
  }, [sessionId, active, processEvent, resetControls, controlScope, environmentSignal, reconnectRevision]);

  useEffect(() => {
    if (windowActive && active && sessionId) void connectRef.current?.();
  }, [active, sessionId, windowActive]);

  const nativeMessage = useCallback(async (mode, text, attachments) => {
    if (!isV4 || imageSelectionRef.current !== imageSelection || controlScopeRef.current !== controlScope || !sessionId || environmentSignalRef.current.aborted
      || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return { accepted: false };
    if (mode !== 'check' && historyOnlyRef.current === controlScope) return { accepted: false, historyOnly: true };
    if (getActiveEnvironment()) throw new Error('Image sends require an owned V4 conversation on the home server. Your draft was kept.');
    const auth = captureAuthScope(), environment = environmentSignalRef.current;
    if (!auth.userId) throw new Error('Sign in before using saved images.');
    if (mode === 'send' && !composerStore.getImageStore?.()) {
      const failure = 'Images must be saved on this device before sending. Add them to this conversation first. Your draft was kept.';
      setSendError(failure); throw new Error(failure);
    }
    if (sendRequestRef.current) return { accepted: false, pending: true };
    const lease = composerStore.claimSend(); if (!lease) return { accepted: false, pending: true };
    const request = { controller: new AbortController(), generation: actionGenerationRef.current, store: composerStore, lease };
    sendRequestRef.current = request;
    const sameFlightScope = () => controlScopeRef.current === controlScope && actionGenerationRef.current === request.generation
      && !controlScope.signal.aborted && !environment.aborted && isAuthScopeCurrent(auth);
    const current = () => sameFlightScope() && imageSelectionRef.current === imageSelection;
    const signal = AbortSignal.any([request.controller.signal, environment]);
    const insertAt = messagesRef.current.length;
    setIsSending(true); setSendError('');
    try {
      return await runNativeImageMessage({ mode, text, attachments, sessionId, composerStore, auth, selection: imageSelection, signal, current,
        requiresCleanup: () => requiresCleanup, historyOnly: () => historyOnlyRef.current === controlScope,
        onNotice: setSendError,
        onAccepted: (intent, receipt) => setMessages(previous => current() ? mergeUserMessage(previous, { role: 'user', content: intent.text,
          ...(intent.kind === 'images-v1' ? { attachments: intent.attachments } : {}), requestId: receipt.requestId,
          messageId: receipt.messageId, turnId: receipt.turnId, seq: receipt.acceptedSeq }, insertAt) : previous),
      });
    } catch (problem) {
      if (!current()) return { accepted: false, stale: true };
      setSendError(problem.message); throw problem;
    } finally {
      if (sendRequestRef.current === request) { sendRequestRef.current = null; composerStore.releaseSend(lease); if (sameFlightScope()) setIsSending(false); }
    }
  }, [isV4, sessionId, composerStore, controlScope, imageSelection, requiresCleanup]);
  const checkPendingMessage = useCallback(() => nativeMessage('check'), [nativeMessage]);
  const retryPendingMessage = useCallback(() => nativeMessage('retry'), [nativeMessage]);

  const sendMessage = useCallback(
    async (text, attachments) => {
      if (controlScopeRef.current !== controlScope || !sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return { accepted: false };
      if (historyOnlyRef.current === controlScope) return { accepted: false, historyOnly: true };
      const hasImages = attachments !== undefined && !(Array.isArray(attachments) && attachments.length === 0);
      if (hasImages || isV4 && composerStore.getImageStore?.()) return nativeMessage('send', text, attachments);
      if (!text?.trim()) return { accepted: false };
      if (sendRequestRef.current) return { accepted: false, pending: true };
      if (hasReceipts && requiresCleanup) {
        const failure = 'Cleanup is not confirmed. Retry cancellation before sending. Your draft was kept.';
        setSendError(failure); throw new Error(failure);
      }
      const lease = hasReceipts ? composerStore.claimSend() : null;
      if (hasReceipts && !lease) return { accepted: false, pending: true };
      const request = { controller: new AbortController(), generation: actionGenerationRef.current, store: hasReceipts ? composerStore : null, lease };
      sendRequestRef.current = request;
      const current = () => controlScopeRef.current === controlScope && actionGenerationRef.current === request.generation && !controlScope.signal.aborted;
      const message = text.trim();
      const insertAt = messagesRef.current.length;
      let requestId = null;
      let checkingStoredReceipt = false;
      const signal = AbortSignal.any([request.controller.signal, environmentSignalRef.current]);
      const acceptedReceipt = receipt => isAcceptedReceipt(receipt, requestId);
      const accept = async receipt => {
        if (hasReceipts) await composerStore.confirmIntent(requestId);
        if (!current()) return { accepted: false, stale: true };
        if (runtime === 'codex' && ['accepted', 'running'].includes(receipt?.status) && !completedTurnsRef.current.has(receipt.turnId)) { activeTurnRef.current = receipt.turnId; setIsStreaming(true); }
        setMessages(previous => {
          if (!hasReceipts && previous.slice(insertAt).some(existing => existing.role === 'user' && existing.content === message && existing.messageId)) return previous;
          return mergeUserMessage(previous, {
          role: 'user', content: message, ...(!hasReceipts ? { legacyPending: true } : {}),
          ...(receipt ? { requestId: receipt.requestId, messageId: receipt.messageId, turnId: receipt.turnId, seq: receipt.acceptedSeq } : {}),
        }, insertAt);
        });
        return { accepted: true, ...receipt };
      };
      setIsSending(true); setSendError('');
      try {
        if (hasReceipts) {
          const preparation = composerStore.prepareIntent(message);
          const intent = preparation && typeof preparation.then === 'function' ? await preparation : preparation;
          if (!current()) return { accepted: false, stale: true };
          requestId = intent.requestId;
          if (intent.reused) {
            checkingStoredReceipt = true;
            const lookup = await apiFetch(`/api/structured/sessions/${sessionId}/requests/${requestId}`, { signal });
            if (!current()) return { accepted: false, stale: true };
            if (lookup.ok) {
              const receipt = await lookup.json();
              if (!current()) return { accepted: false, stale: true };
              if (!acceptedReceipt(receipt)) throw new Error('Saved message receipt or image manifest could not be confirmed. Your draft and request identity were kept.');
              return await accept(receipt);
            }
            if (lookup.status !== 404) throw new Error('Saved message status could not be checked. Your draft and request identity were kept.');
            checkingStoredReceipt = false;
          }
        }
        if (historyOnlyRef.current === controlScope) return { accepted: false, historyOnly: true };
        const response = await apiFetch(`/api/structured/sessions/${sessionId}/input`, {
          method: 'POST', body: { text: `${message}\n`, fallbackToMessage: true, ...(requestId ? { requestId } : {}) }, signal,
        });
        if (!current()) return { accepted: false, stale: true };
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const error = new Error(payload?.error || `Message was not accepted (${response.status}).`);
          error.rejected = !(response.status >= 500); throw error;
        }
        const receipt = hasReceipts ? await response.json() : null;
        if (!current()) return { accepted: false, stale: true };
        if (hasReceipts && !acceptedReceipt(receipt)) throw new Error('Invalid message receipt or image manifest');
        return await accept(receipt);
      } catch (error) {
        if (!current()) return { accepted: false, stale: true };
        if (hasReceipts && requestId && !error.rejected && !checkingStoredReceipt) {
          try {
            const lookup = await apiFetch(`/api/structured/sessions/${sessionId}/requests/${requestId}`, { signal });
            const receipt = lookup.ok ? await lookup.json() : null;
            if (!current()) return { accepted: false, stale: true };
            if (acceptedReceipt(receipt)) return await accept(receipt);
          } catch { /* An uncertain receipt must retain the draft and the same retry identity. */ }
        }
        if (!current()) return { accepted: false, stale: true };
        const failure = !requestId && hasReceipts ? error.message : error.rejected ? error.message : hasReceipts
          ? 'Send could not be confirmed. Your draft was kept. Retry this draft to check the same request without sending it twice.'
          : 'Send could not be confirmed. Your draft was kept. Check the conversation before retrying to avoid sending twice.';
        setSendError(failure); throw new Error(failure);
      } finally {
        if (sendRequestRef.current === request) {
          sendRequestRef.current = null;
          request.store?.releaseSend(request.lease);
          if (current()) setIsSending(false);
        }
      }
    }, [sessionId, hasReceipts, runtime, requiresCleanup, composerStore, controlScope, nativeMessage]
  );

  const interrupt = useCallback(async () => {
    if (controlScopeRef.current !== controlScope || !sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return { accepted: false };
    if (interruptRequestRef.current) return { accepted: false, pending: true };
    const request = { controller: new AbortController(), generation: actionGenerationRef.current, cleanupSeq: cleanupSeqRef.current };
    interruptRequestRef.current = request;
    const current = () => controlScopeRef.current === controlScope && actionGenerationRef.current === request.generation && !controlScope.signal.aborted;
    setIsInterrupting(true); setControlError('');
    try {
      const response = await apiFetch(`/api/structured/sessions/${sessionId}/interrupt`, {
        method: 'POST', signal: AbortSignal.any([request.controller.signal, environmentSignalRef.current]),
      });
      if (!current()) return { accepted: false, stale: true };
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Stop was not confirmed (${response.status}). Retry Stop.`);
      }
      const receipt = hasReceipts ? await response.json().catch(() => null) : null;
      if (!current()) return { accepted: false, stale: true };
      if (hasReceipts && (receipt?.cleanupConfirmed !== true || receipt.status !== 'cancelled')) throw new Error('Stop cleanup could not be confirmed. The conversation was kept. Retry Stop.');
      if (hasReceipts && cleanupSeqRef.current <= request.cleanupSeq) { cleanupRequiredRef.current = false; setRequiresCleanup(false); }
      return { accepted: true, ...receipt };
    } catch (error) {
      if (!current()) return { accepted: false, stale: true };
      if (hasReceipts && cleanupSeqRef.current > request.cleanupSeq && !cleanupRequiredRef.current) return { accepted: true, reconciled: true };
      if (hasReceipts) { cleanupRequiredRef.current = true; setRequiresCleanup(true); }
      setControlError(error instanceof TypeError ? 'Stop could not be confirmed. The conversation was kept. Retry Stop when the connection is available.' : error.message || 'Stop could not be confirmed. Retry Stop.');
      return { accepted: false };
    } finally {
      if (interruptRequestRef.current === request) { interruptRequestRef.current = null; if (current()) setIsInterrupting(false); }
    }
  }, [sessionId, hasReceipts, controlScope]);

  const approve = useCallback(
    async (approved, expectedApproval, answers, { forSession = false } = {}) => {
      if (controlScopeRef.current !== controlScope || !sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return { accepted: false };
      const approval = pendingApprovalRef.current;
      if (!approval || (expectedApproval && expectedApproval !== approval)) return { accepted: false, stale: true };
      if (approval.decisionUncertain || approval.decisionUnconfirmed) { setApprovalError('This decision may have been delivered. Check its outcome before continuing.'); return { accepted: false }; }
      if (approvalRequestRef.current) return { accepted: false, pending: true };
      if (hasReceipts && !approval.approvalId) { setApprovalError('This action has no server approval ID. Reconnect before deciding.'); return { accepted: false }; }
      const request = { controller: new AbortController(), generation: actionGenerationRef.current };
      approvalRequestRef.current = request;
      const current = () => controlScopeRef.current === controlScope && actionGenerationRef.current === request.generation && !controlScope.signal.aborted;
      setIsApproving(true); setApprovalError('');
      let dispatched = false;
      try {
        let reservation = null;
        if (runtime === 'codex') {
          const capabilityResponse = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/approval-capability`, {
            signal: AbortSignal.any([request.controller.signal, environmentSignalRef.current]), cache: 'no-store',
          });
          const capability = await capabilityResponse.json().catch(() => null);
          if (!current()) return { accepted: false, stale: true };
          if (pendingApprovalRef.current !== approval) return { accepted: false, stale: true };
          if (!capabilityResponse.ok || capability?.protocol !== 1 || !['reservation', 'legacy', 'recovery_required'].includes(capability.mode) || typeof capability.outstanding !== 'boolean') throw new Error('Approval safety could not be verified. Try again when the server is available.');
          if (capability.outstanding || capability.mode === 'recovery_required') {
            if (pendingApprovalRef.current === approval) {
              const held = { ...approval, decisionUnconfirmed: true, reviewUnavailable: capability.mode === 'recovery_required' };
              pendingApprovalRef.current = held; setPendingApproval(held);
            }
            return { accepted: false };
          }
          const store = approvalStore();
          const intent = await store.reserve(approval.approvalId, capability.mode);
          if (!current()) {
            await store.clearUndispatched(approval.approvalId, intent.intentId);
            return { accepted: false, stale: true };
          }
          if (pendingApprovalRef.current !== approval) {
            await store.clearUndispatched(approval.approvalId, intent.intentId);
            return { accepted: false, stale: true };
          }
          const unconfirmed = { ...approval, decisionUnconfirmed: true, reviewUnavailable: capability.mode === 'legacy' };
          pendingApprovalRef.current = unconfirmed; setPendingApproval(unconfirmed);
          dispatched = true;
          if (capability.mode === 'reservation') {
            const reserved = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/approval-claims/${encodeURIComponent(approval.approvalId)}/reserve`, {
              method: 'POST', signal: AbortSignal.any([request.controller.signal, environmentSignalRef.current]),
            });
            const value = await reserved.json().catch(() => null);
            if (!current()) return { accepted: false, stale: true };
            if (reserved.status === 409 && value?.status === 'not_started') {
              const pending = pendingApprovalRef.current;
              await approvalStore().clear(approval.approvalId);
              if (!current()) return { accepted: false, stale: true };
              if (pending === pendingApprovalRef.current && pending?.approvalId === approval.approvalId && !pending.reservationId && !pending.decisionUncertain) {
                pendingApprovalRef.current = approval; setPendingApproval(approval);
              }
              setApprovalError(value.error || 'Session is busy; try again.');
              return { accepted: false };
            }
            if (!reserved.ok || value?.status !== 'reserved' || value.approvalId !== approval.approvalId
              || typeof value.reservationId !== 'string' || !value.reservationId || value.reservationId.length > 256
              || typeof value.deliveryToken !== 'string' || !value.deliveryToken || value.deliveryToken.length > 4096) throw new Error('Approval reservation could not be confirmed.');
            const pending = pendingApprovalRef.current;
            if (pending?.approvalId !== approval.approvalId || pending.decisionUncertain || (pending.reservationId && pending.reservationId !== value.reservationId)) return { accepted: false, stale: true };
            reservation = { reservationId: value.reservationId, reservationToken: value.deliveryToken };
          }
        }
        dispatched = true;
        const response = await apiFetch(`/api/structured/sessions/${sessionId}/approve`, {
          method: 'POST', body: { approved, ...(hasReceipts || approval.approvalId ? { approvalId: approval.approvalId } : {}), ...(reservation || {}), ...(approved && answers ? { answers } : {}), ...(approved && forSession ? { forSession: true } : {}) },
          signal: AbortSignal.any([request.controller.signal, environmentSignalRef.current]),
        });
        if (!current()) return { accepted: false, stale: true };
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || `Approval decision was not accepted (${response.status}).`);
        }
        if (hasReceipts) {
          const receipt = await response.json().catch(() => null);
          if (!current()) return { accepted: false, stale: true };
          if (!['accepted', 'already_decided'].includes(receipt?.status) || receipt.approvalId !== approval.approvalId || receipt.approved !== approved) throw new Error('Approval decision could not be confirmed for this action. Review the current action before retrying.');
        }
        if (runtime !== 'codex' && pendingApprovalRef.current === approval) { pendingApprovalRef.current = null; setPendingApproval(null); }
        return { accepted: true };
      } catch (error) {
        if (!current()) return { accepted: false, stale: true };
        if (pendingApprovalRef.current?.approvalId === approval.approvalId) {
          if (runtime === 'codex' && dispatched) {
            setApprovalError('The decision could not be confirmed and may have been delivered. Do not send it again; check the session for updates.');
          } else setApprovalError(error.message || 'Decision could not be confirmed. Review the current action before retrying.');
        }
        return { accepted: false };
      } finally {
        if (approvalRequestRef.current === request) {
          approvalRequestRef.current = null;
          if (current()) setIsApproving(false);
        }
      }
    },
    [sessionId, hasReceipts, runtime, controlScope, approvalStore]
  );

  const reviewApproval = useCallback(async expectedApproval => {
    if (runtime !== 'codex' || controlScopeRef.current !== controlScope || !sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return { accepted: false };
    const approval = pendingApprovalRef.current;
    if (!(approval?.decisionUncertain || approval?.decisionUnconfirmed) || approval.reviewUnavailable || !approval.approvalId || (expectedApproval && expectedApproval !== approval)) return { accepted: false, stale: true };
    if (approvalRequestRef.current) return { accepted: false, pending: true };
    const request = { controller: new AbortController(), generation: actionGenerationRef.current };
    approvalRequestRef.current = request;
    const current = () => controlScopeRef.current === controlScope && actionGenerationRef.current === request.generation && !controlScope.signal.aborted;
    setIsApproving(true); setApprovalError('');
    try {
      const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/approval-claims/${encodeURIComponent(approval.approvalId)}/review`, {
        method: 'POST', signal: AbortSignal.any([request.controller.signal, environmentSignalRef.current]),
      });
      const receipt = await response.json().catch(() => null);
      if (!current()) return { accepted: false, stale: true };
      if (response.status === 404 && pendingApprovalRef.current?.approvalId === approval.approvalId) {
        const unavailable = { ...pendingApprovalRef.current, reviewUnavailable: true };
        pendingApprovalRef.current = unavailable; setPendingApproval(unavailable);
        throw new Error('This server cannot safely acknowledge the decision. Stop the session and inspect the terminal.');
      }
      if (!response.ok) throw new Error(receipt?.error || 'Approval review could not be confirmed.');
      if (receipt?.approvalId !== approval.approvalId || receipt.status !== 'reviewed') throw new Error('Approval review could not be confirmed.');
      await approvalStore().clear(approval.approvalId);
      if (!current()) return { accepted: false, stale: true };
      if (pendingApprovalRef.current?.approvalId === approval.approvalId) { pendingApprovalRef.current = null; setPendingApproval(null); }
      return { accepted: true };
    } catch (error) {
      if (!current()) return { accepted: false, stale: true };
      if (pendingApprovalRef.current?.approvalId === approval.approvalId) setApprovalError(error.message || 'Approval review could not be confirmed.');
      return { accepted: false };
    } finally {
      if (approvalRequestRef.current === request) {
        approvalRequestRef.current = null;
        if (current()) setIsApproving(false);
      }
    }
  }, [sessionId, runtime, controlScope, approvalStore]);

  return {
    messages,
    contextUsage: contextUsage?.sessionId === sessionId ? contextUsage.usage : null,
    controlState, controlError,
    currentToolCalls,
    pendingApproval,
    isStreaming, requiresCleanup,
    connectionState,
    isHistoryOnly: historyOnlyScope === controlScope,
    isSending: hasReceipts ? sharedIsSending : isSending, isApproving, isInterrupting, actionError: [sendError, approvalError, controlError, transportError].filter(Boolean).join('\n'),
    sendMessage,
    reconnect,
    checkPendingMessage,
    retryPendingMessage,
    interrupt,
    approve,
    reviewApproval,
  };
}
