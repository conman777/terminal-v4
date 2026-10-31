export function latestContextUsage(controlState) {
  const entries = controlState?.entries || [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === 'context_usage' && entries[index].usage) return entries[index].usage;
  }
  return null;
}

// A small "Context N%" reading for the composer, with token and cost detail for its tooltip.
export function contextMeter(usage) {
  const validTokens = value => Number.isSafeInteger(value) && value >= 0;
  if (!validTokens(usage?.contextWindow) || usage.contextWindow === 0 || !validTokens(usage.contextTokens)) return null;
  const percent = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
  const tokens = value => value.toLocaleString('en-US');
  const parts = [`${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow)} tokens`];
  const counters = [];
  if (validTokens(usage.inputTokens)) counters.push(`${tokens(usage.inputTokens)} in`);
  if (validTokens(usage.outputTokens)) counters.push(`${tokens(usage.outputTokens)} out`);
  if (counters.length) parts.push(counters.join(', '));
  if (Number.isFinite(usage.costUsd) && usage.costUsd >= 0) parts.push(`$${usage.costUsd.toFixed(2)}`);
  return { percent, label: `Context ${percent}%`, detail: parts.join(' · ') };
}
