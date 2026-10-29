export function isSnoozedThread(session) {
  const lifecycle = session?.threadLifecycle;
  return typeof session?.id === 'string' && session.id.startsWith('ss-') && lifecycle?.supported === true
    && lifecycle.snoozed === true && lifecycle.requiresAttention === false;
}

export function isSettledThread(session, activity) {
  const lifecycle = session?.threadLifecycle;
  return typeof session?.id === 'string' && session.id.startsWith('ss-')
    && session.runtime === 'v4' && !session.thread?.archived
    && ['idle', 'completed', 'cancelled'].includes(session.status)
    && session.isBusy !== true && activity?.isBusy !== true
    && lifecycle?.settlementSupported === true && lifecycle.settled === true
    && lifecycle.requiresAttention === false && lifecycle.snoozed !== true;
}
