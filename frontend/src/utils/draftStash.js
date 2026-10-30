import { getEnvironmentCacheScope, getEnvironmentStorage } from './remoteEnvironments';

const KEY = 'tv4StashedDrafts:v2';
const LIMIT = 20;

function scopedStorage() {
  return getEnvironmentCacheScope().identity ? getEnvironmentStorage() : null;
}

export function loadStash() {
  const storage = scopedStorage();
  if (!storage) return [];
  try {
    const items = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => typeof item?.text === 'string' && item.id) : [];
  } catch { return []; }
}

function save(items) {
  const storage = scopedStorage();
  if (!storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify(items.slice(0, LIMIT)));
    return true;
  } catch { return false; }
}

// Saves a draft for later (T3 Code's composer stash); newest first. `ok` is false when it could not be stored.
export function stashDraft(text, now = Date.now()) {
  if (!text?.trim()) return { ok: true, items: loadStash() };
  const items = [{ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text, at: now }, ...loadStash()];
  const ok = save(items);
  return { ok, items: loadStash() };
}

// Removes a stashed draft and returns its text.
export function takeStashed(id) {
  const items = loadStash();
  const item = items.find(entry => entry.id === id);
  save(items.filter(entry => entry.id !== id));
  return item?.text ?? '';
}
