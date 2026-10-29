const KEY = 'tv4LearningNudges';
const FIRST_AFTER = 4;
const AGAIN_AFTER = 6;

function dismissed() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

// Like Hermes's background review, but asked rather than automatic: after a few turns, offer to save what was learned.
export function shouldNudgeLearning(sessionId, userTurns) {
  if (!sessionId || userTurns < FIRST_AFTER) return false;
  const at = dismissed()[sessionId];
  return at == null || userTurns >= at + AGAIN_AFTER;
}

export function dismissLearningNudge(sessionId, userTurns) {
  const next = { ...dismissed(), [sessionId]: userTurns };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* shows again next time */ }
}
