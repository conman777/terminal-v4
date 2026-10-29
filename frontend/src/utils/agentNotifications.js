const KEY = 'tv4AgentNotifications';
const MIN_WORK_MS = 5000;
const BODIES = { finished: 'Finished and ready for you.', approval: 'Needs your approval or an answer.' };

export function agentNotificationsEnabled() {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

export function setAgentNotificationsEnabled(enabled) {
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* preference stays off */ }
}

export async function requestAgentNotifications() {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  setAgentNotificationsEnabled(permission === 'granted');
  return permission;
}

// A system notification for agent work, shown only while the user is looking elsewhere.
export function notifyAgent(kind, title) {
  if (!agentNotificationsEnabled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try { new Notification(title || 'Terminal v4', { body: BODIES[kind] || BODIES.finished, tag: `${kind}:${title}` }); } catch { /* notifications unavailable */ }
}

// Session ids that went from busy to idle after at least MIN_WORK_MS of work; updates `busySince`.
export function busyTransitions(activity, previous, busySince, now = Date.now()) {
  const finished = [];
  for (const [id, state] of Object.entries(activity || {})) {
    const wasBusy = Boolean(previous?.[id]?.isBusy);
    if (state?.isBusy && !wasBusy) busySince[id] = now;
    if (!state?.isBusy && wasBusy) {
      if (now - (busySince[id] ?? now) >= MIN_WORK_MS) finished.push(id);
      delete busySince[id];
    }
  }
  return finished;
}
