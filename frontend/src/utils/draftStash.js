const KEY = 'tv4StashedDrafts';
const LIMIT = 20;

export function loadStash() {
  try {
    const items = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => typeof item?.text === 'string' && item.id) : [];
  } catch { return []; }
}

function save(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, LIMIT))); } catch { /* stash unavailable */ }
}

// Saves a draft for later (T3 Code's composer stash); newest first.
export function stashDraft(text, now = Date.now()) {
  if (!text?.trim()) return loadStash();
  const items = [{ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text, at: now }, ...loadStash()];
  save(items);
  return loadStash();
}

// Removes a stashed draft and returns its text.
export function takeStashed(id) {
  const items = loadStash();
  const item = items.find(entry => entry.id === id);
  save(items.filter(entry => entry.id !== id));
  return item?.text ?? '';
}
