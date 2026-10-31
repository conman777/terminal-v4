// This is a tab-local fence, not a cross-version installation authority.
const SELECTION_KEY = 'terminal-v4-strict-auth-selection-v1';
const SELECTION_VALUE = 'strict-v1';
let selected = true;
let storageReady = false;
try {
  const marker = sessionStorage.getItem(SELECTION_KEY);
  if (marker === null) { selected = false; storageReady = true; }
  else if (marker === SELECTION_VALUE) { selected = true; storageReady = true; }
} catch { /* Unavailable storage cannot prove this tab is legacy. */ }
const legacyRequests = typeof AbortController === 'function' ? new AbortController() : null;
if (selected) legacyRequests?.abort();

function inspectMarker() {
  try {
    const marker = sessionStorage.getItem(SELECTION_KEY);
    if (marker === SELECTION_VALUE) {
      if (!selected) { selected = true; legacyRequests?.abort(); }
    } else if (marker !== null) {
      selected = true;
      storageReady = false;
      legacyRequests?.abort();
    } else if (selected) {
      storageReady = false;
    }
  } catch {
    selected = true;
    storageReady = false;
    legacyRequests?.abort();
  }
}

export function selectStrictAuth() {
  inspectMarker();
  if (selected) return storageReady;
  selected = true;
  legacyRequests?.abort();
  try {
    sessionStorage.setItem(SELECTION_KEY, SELECTION_VALUE);
    storageReady = sessionStorage.getItem(SELECTION_KEY) === SELECTION_VALUE;
  } catch { storageReady = false; }
  return storageReady;
}

export function isStrictAuthSelected() {
  inspectMarker();
  return selected;
}

export function legacyAuthSignal() {
  return legacyRequests?.signal;
}

export function assertLegacyAuthAllowed() {
  if (isStrictAuthSelected()) throw new Error('Legacy authentication is unavailable');
}
