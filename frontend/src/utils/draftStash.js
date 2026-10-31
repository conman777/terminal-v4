import { getEnvironmentCacheScope, getEnvironmentStorage } from './remoteEnvironments';

const KEY = 'tv4StashedDrafts:v2';
const LIMIT = 20;

function scopedStorage() {
  return getEnvironmentCacheScope().identity ? getEnvironmentStorage() : null;
}

function readStash() {
  const storage = scopedStorage();
  if (!storage) return { ok: false, items: [] };
  try {
    const items = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (!Array.isArray(items) || items.some(item => typeof item?.text !== 'string' || !item.id)) return { ok: false, items: [] };
    return { ok: true, items };
  } catch { return { ok: false, items: [] }; }
}

export function loadStash() { return readStash().items; }

function save(items) {
  const storage = scopedStorage();
  if (!storage) return false;
  try {
    const encoded = JSON.stringify(items);
    storage.setItem(KEY, encoded);
    return storage.getItem(KEY) === encoded;
  } catch { return false; }
}

// Saves a draft for later (T3 Code's composer stash); newest first. `ok` is false when it could not be stored.
export function stashDraft(text, now = Date.now()) {
  if (!text?.trim()) return { ok: true, items: loadStash() };
  const existing = readStash();
  if (!existing.ok) return { ok: false, reason: 'unreadable', items: [] };
  const previous = existing.items;
  if (previous.length >= LIMIT) return { ok: false, reason: 'full', items: previous };
  const items = [{ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text, at: now }, ...previous];
  const ok = save(items);
  return { ok, items: loadStash() };
}

export function stashFailureMessage(result) {
  return result.reason === 'full'
    ? 'Your stash is full. Restore a saved draft before stashing another; this draft remains in the composer.'
    : result.reason === 'unreadable'
      ? 'Saved drafts could not be read on this device. This draft remains in the composer; check browser storage before trying again.'
    : 'This draft could not be stashed on this device, so it was kept in the composer. Free local storage and try again.';
}

// Removes a stashed draft and returns its text.
export function takeStashed(id) {
  const items = loadStash();
  const item = items.find(entry => entry.id === id);
  save(items.filter(entry => entry.id !== id));
  return item?.text ?? '';
}
