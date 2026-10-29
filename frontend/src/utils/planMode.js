// Plan mode messages carry this marker; the server runs those turns read-only.
export const PLAN_MARKER = '[Plan] ';

export function isPlanMessage(text) {
  return typeof text === 'string' && text.startsWith(PLAN_MARKER);
}

export function stripPlanMarker(text) {
  return isPlanMessage(text) ? text.slice(PLAN_MARKER.length) : text;
}

// Adds T3 Code's "Implement plan" actions after the final reply of each finished plan turn.
export function attachPlanActions(items, { inProgress = false } = {}) {
  const result = [];
  let planTurn = false;
  let lastReply = null;
  const close = () => {
    if (planTurn && lastReply) result.push({ role: 'plan-actions', plan: lastReply.content, key: lastReply.messageId || result.length });
  };
  items.forEach((item, index) => {
    if (item.role === 'user') {
      close();
      planTurn = isPlanMessage(item.content);
      lastReply = null;
    } else if (item.role === 'assistant' && typeof item.content === 'string') {
      lastReply = item;
    }
    result.push(item);
    if (index === items.length - 1 && !inProgress) close();
  });
  return result.length === items.length ? items : result;
}
