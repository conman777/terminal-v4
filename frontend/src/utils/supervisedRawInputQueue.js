import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from './auth';
import { getEnvironmentSignal, subscribeEnvironment } from './remoteEnvironments';

const encoder = new TextEncoder();
const queues = new WeakMap();
const visible = new Set();
const listeners = new Set();
let visibleSnapshot = [];
let scopeDropNotice = false;
let scopeSendUncertain = false;

function publishVisible() {
  visibleSnapshot = [...visible].filter(entry => entry.current()).map(entry => ({ sessionId: entry.sessionId, queue: entry.queue, ...entry.queue.getSnapshot() }))
    .filter(entry => entry.pending || entry.sending || entry.halted || entry.error);
  if (scopeDropNotice) visibleSnapshot.push(scopeSendUncertain ? { scopeChanged: true, scopeUncertain: true } : { scopeChanged: true });
  listeners.forEach(listener => listener());
}
export const subscribeSupervisedInputQueues = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const getSupervisedInputQueues = () => visibleSnapshot;
export function dismissSupervisedInputScopeNotice() { scopeDropNotice = false; scopeSendUncertain = false; publishVisible(); }

function clearOldScopes() {
  for (const entry of visible) if (!entry.current()) {
    const state = entry.queue.getSnapshot();
    if (state.pending > 0 || state.sending) scopeDropNotice = true;
    if (state.sending) scopeSendUncertain = true;
    entry.queue.discard(); visible.delete(entry);
  }
  publishVisible();
}
subscribeAuth(clearOldScopes);
subscribeEnvironment(clearOldScopes);

if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (!visibleSnapshot.some(entry => entry.pending > 0 || entry.sending)) return;
  event.preventDefault(); event.returnValue = '';
});

export function supervisedInputQueue(sessionId, send, mode = 'supervised') {
  const signal = getEnvironmentSignal(), auth = captureAuthScope();
  let scope = queues.get(signal);
  if (!scope) { scope = new Map(); queues.set(signal, scope); }
  const key = JSON.stringify([auth.home, auth.userId, auth.session, sessionId]);
  let entry = scope.get(key);
  if (!entry) {
    const current = () => !signal.aborted && isAuthScopeCurrent(auth);
    entry = { sessionId, current, queue: null, mode, send };
    entry.queue = createSupervisedRawInputQueue(text => entry.send(text), current, 4096, () => {
      const state = entry.queue.getSnapshot();
      if (state.pending || state.sending || state.halted || state.error) visible.add(entry); else visible.delete(entry);
      publishVisible();
    });
    scope.set(key, entry);
  }
  const state = entry.queue.getSnapshot();
  if (entry.mode !== mode && (state.pending || state.sending || state.halted)) {
    return { enqueue: () => { entry.queue.rejectModeChange(); return false; } };
  }
  entry.mode = mode;
  entry.send = send;
  return entry.queue;
}

export function createSupervisedRawInputQueue(send, isCurrent, limit = 4096, onChange = () => {}) {
  let buffer = '', activeBytes = 0, sending = false, halted = false, error = '', timer = null;
  let snapshot = { pending: 0, sending: false, halted: false, error: '' };
  const listeners = new Set();
  const publish = () => {
    snapshot = { pending: buffer.length, sending, halted, error };
    listeners.forEach(listener => listener()); onChange();
  };
  const schedule = () => {
    if (timer || sending || halted || !buffer) return;
    timer = setTimeout(flush, 40);
  };
  async function flush() {
    timer = null;
    if (sending || halted || !buffer) return;
    if (!isCurrent()) { halted = true; error = 'The account or environment changed. Pending keys were not sent.'; publish(); return; }
    const batch = buffer; buffer = ''; activeBytes = encoder.encode(batch).length; sending = true; error = ''; publish();
    try {
      const result = await send(batch);
      if (result?.accepted !== true) throw new Error('Terminal input was not accepted.');
    } catch (failure) {
      if (isCurrent()) {
        if (!failure?.deliveryUncertain) buffer = batch + buffer;
        halted = true;
        error = failure?.message || 'Terminal input could not be sent.';
      }
    } finally {
      activeBytes = 0; sending = false; publish(); schedule();
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    rejectModeChange() { error = 'Input mode changed. Finish or review waiting input before typing more.'; publish(); },
    enqueue(value) {
      if (typeof value !== 'string' || !value || !isCurrent()) return false;
      if (halted) { error = 'Input is paused. Review the pending delivery before sending more.'; publish(); return false; }
      if (activeBytes + encoder.encode(buffer + value).length > limit) { error = 'Input buffer is full. Some keys were not queued; wait, then type them again.'; publish(); return false; }
      buffer += value; publish(); schedule(); return true;
    },
    resume() { if (!isCurrent()) return; halted = false; error = ''; publish(); schedule(); },
    discard() { buffer = ''; halted = false; error = ''; if (timer) clearTimeout(timer); timer = null; publish(); },
  };
}
