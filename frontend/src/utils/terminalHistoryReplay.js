const DEFAULT_HISTORY_REPLAY_OBSERVER_CHARS = 4_000;
const DEFAULT_SINGLE_WRITE_HISTORY_CHARS = 250_000;

function normalizePositiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function shouldUseSingleHistoryWrite(historyTextLength, chunkSize) {
  const normalizedLength = normalizePositiveNumber(historyTextLength, 0);
  if (normalizedLength === 0) {
    return false;
  }

  const normalizedChunkSize = normalizePositiveNumber(chunkSize, 1);
  return normalizedLength <= Math.max(normalizedChunkSize, DEFAULT_SINGLE_WRITE_HISTORY_CHARS);
}

export function getHistoryReplayObserverText(historyText, maxChars = DEFAULT_HISTORY_REPLAY_OBSERVER_CHARS) {
  if (typeof historyText !== 'string' || historyText.length === 0) {
    return '';
  }

  const normalizedMaxChars = Math.floor(normalizePositiveNumber(maxChars, DEFAULT_HISTORY_REPLAY_OBSERVER_CHARS));
  return historyText.slice(-normalizedMaxChars);
}
