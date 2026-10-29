export function latestContextUsage(controlState) {
  const entries = controlState?.entries || [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === 'context_usage' && entries[index].usage) return entries[index].usage;
  }
  return null;
}

// A small "Context N%" reading for the composer, with token and cost detail for its tooltip.
export function contextMeter(usage) {
  if (!usage?.contextWindow || !Number.isFinite(usage.contextTokens)) return null;
  const percent = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
  const tokens = value => Number(value || 0).toLocaleString('en-US');
  const parts = [`${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow)} tokens`];
  if (Number.isFinite(usage.inputTokens)) parts.push(`${tokens(usage.inputTokens)} in, ${tokens(usage.outputTokens)} out`);
  if (Number.isFinite(usage.costUsd)) parts.push(`$${usage.costUsd.toFixed(2)}`);
  return { percent, label: `Context ${percent}%`, detail: parts.join(' · ') };
}
