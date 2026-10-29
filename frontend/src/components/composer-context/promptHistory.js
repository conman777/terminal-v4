import { getEnvironmentStorage } from '../../utils/remoteEnvironments';
import { splitContext } from './composerContext';

const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 4000;
const keyFor = sessionId => `promptHistory:v1:${encodeURIComponent(String(sessionId ?? ''))}`;

export function readPromptHistory(sessionId) {
  try {
    const value = JSON.parse(getEnvironmentStorage().getItem(keyFor(sessionId)) || '[]');
    return Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry) : [];
  } catch { return []; }
}

export function recordPrompt(sessionId, submitted) {
  const text = splitContext(submitted).text.trim().slice(0, MAX_ENTRY_CHARS);
  if (!text) return;
  const entries = readPromptHistory(sessionId);
  if (entries.at(-1) === text) return;
  try { getEnvironmentStorage().setItem(keyFor(sessionId), JSON.stringify([...entries, text].slice(-MAX_ENTRIES))); } catch { /* History is a convenience. */ }
}

export function stepPromptHistory(entries, index, direction) {
  if (direction === 'up') {
    if (!entries.length) return null;
    const next = index === -1 ? entries.length - 1 : Math.max(0, index - 1);
    return { index: next, text: entries[next] };
  }
  if (index === -1) return null;
  return index + 1 >= entries.length ? { index: -1, text: '' } : { index: index + 1, text: entries[index + 1] };
}
