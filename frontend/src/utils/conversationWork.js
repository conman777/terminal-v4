const FOLDABLE = new Set(['activity', 'assistant', 'reasoning', 'plan']);

function foldSegment(lead, segment) {
  const finalIndex = segment.map(item => item.role).lastIndexOf('assistant');
  if (finalIndex <= 0) return segment;
  const before = segment.slice(0, finalIndex);
  const work = before.filter(item => FOLDABLE.has(item.role));
  if (!work.some(item => item.role !== 'assistant')) return segment;
  const start = lead?.ts;
  const end = segment[finalIndex].ts;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  return [
    { role: 'work', items: work, durationMs },
    ...before.filter(item => !FOLDABLE.has(item.role)),
    ...segment.slice(finalIndex),
  ];
}

// Folds each finished turn's tool activity and interim replies into one "Worked for …" group, as T3 Code does.
export function groupTurnWork(timeline, { inProgress = false } = {}) {
  const result = [];
  let lead = null;
  let segment = [];
  const flush = isLast => {
    result.push(...(lead && !(isLast && inProgress) ? foldSegment(lead, segment) : segment));
    segment = [];
  };
  for (const item of timeline) {
    if (item.role === 'user') {
      flush(false);
      result.push(item);
      lead = item;
    } else {
      segment.push(item);
    }
  }
  flush(true);
  return result;
}

export function formatWorkDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return 'Worked';
  if (durationMs < 1000) return 'Worked for <1s';
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `Worked for ${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60 || seconds === 0) return `Worked for ${minutes}m`;
  return `Worked for ${minutes}m ${seconds}s`;
}

// Adds T3 Code's "N changed files" card after the last item of each turn that changed files.
export function attachTurnChanges(items, changesByTurn) {
  if (!changesByTurn || Object.keys(changesByTurn).length === 0) return items;
  const result = [];
  let turnId = null;
  const close = () => {
    if (turnId && changesByTurn[turnId]) result.push({ role: 'turn-changes', turnId, changes: changesByTurn[turnId] });
  };
  for (const item of items) {
    if (item.role === 'user') {
      close();
      turnId = item.turnId || item.messageId || null;
    }
    result.push(item);
  }
  close();
  return result;
}

/** Reads a plan message ({ explanation, steps: [{ step, status }] }); null when it is unusable. */
export function parsePlan(content) {
  let plan;
  try { plan = JSON.parse(content); } catch { return null; }
  const steps = Array.isArray(plan?.steps)
    ? plan.steps.filter(step => typeof step?.step === 'string' && step.step.trim())
    : [];
  if (!steps.length) return null;
  return { explanation: typeof plan.explanation === 'string' ? plan.explanation : '', steps };
}
