export const SNOOZE_MIN_SECONDS = 60;
export const SNOOZE_MAX_SECONDS = 2592000;
const MAX_TIMER_MS = 2147483647;
const RANGE_MESSAGE = 'Enter a snooze between 1 minute and 30 days, such as 90m, 2h or 3d.';

export function snoozeChoices(now = new Date()) {
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return [
    { id: '1h', label: 'Snooze for one hour', seconds: 3600 },
    { id: '4h', label: 'Snooze for 4 hours', seconds: 14400 },
    { id: 'tomorrow', label: 'Snooze until tomorrow morning', seconds: Math.round((morning - now) / 1000) },
  ];
}

export function parseCustomSnooze(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(String(text ?? '').trim());
  if (!match) throw new Error(RANGE_MESSAGE);
  const unit = { m: 60, h: 3600, d: 86400 }[match[2].toLowerCase() || 'h'];
  const seconds = Math.round(Number(match[1]) * unit);
  if (!Number.isSafeInteger(seconds) || seconds < SNOOZE_MIN_SECONDS || seconds > SNOOZE_MAX_SECONDS) throw new Error(RANGE_MESSAGE);
  return seconds;
}

export function promptCustomSnoozeSeconds() {
  const answer = window.prompt('Snooze for how long? Use minutes, hours or days (for example 90m, 2h, 3d). Bare numbers are hours.', '2h');
  return answer === null ? null : parseCustomSnooze(answer);
}

export function settlementUnavailableReason(session) {
  const lifecycle = session?.threadLifecycle;
  if (typeof session?.id !== 'string') return null;
  if (!session.id.startsWith('ss-')) return 'Terminal sessions cannot be settled: Terminal V4 cannot verify their running processes.';
  if (session.runtime !== 'v4') return 'Claude and Codex sessions cannot be settled: Terminal V4 cannot verify their approvals, queued work or running commands.';
  if (lifecycle?.settlementSupported === false) return lifecycle.settlementUnavailableReason || 'Queued work or background commands cannot be verified for this thread right now.';
  return null;
}

export function nextSnoozeExpiryAt(sessions, now = Date.now()) {
  let soonest = null;
  for (const session of sessions || []) {
    const lifecycle = session?.threadLifecycle;
    if (lifecycle?.snoozed !== true || !Number.isFinite(lifecycle.snoozedUntilMs) || lifecycle.snoozedUntilMs <= now) continue;
    if (soonest === null || lifecycle.snoozedUntilMs < soonest) soonest = lifecycle.snoozedUntilMs;
  }
  return soonest;
}

export function nextSnoozeExpiryDelay(sessions, now = Date.now()) {
  const at = nextSnoozeExpiryAt(sessions, now);
  return at === null ? null : Math.min(at - now, MAX_TIMER_MS);
}
