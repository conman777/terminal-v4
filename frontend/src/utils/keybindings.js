const KEY = 'tv4Keybindings';

export const KEYBINDING_ACTIONS = [
  { id: 'commandPalette', label: 'Command palette', binding: 'mod+k', inInputs: true },
  { id: 'findInThread', label: 'Find in thread', binding: 'mod+f', inInputs: true },
  { id: 'toggleSidebar', label: 'Toggle sidebar', binding: 'mod+b' },
  { id: 'togglePreview', label: 'Toggle preview', binding: 'mod+p' },
  { id: 'toggleFullScreen', label: 'Full-screen pane', binding: 'mod+\\' },
  { id: 'newTerminal', label: 'New terminal', binding: 'mod+t' },
  { id: 'closeTerminal', label: 'Close terminal', binding: 'mod+w' },
];

const MODIFIERS = ['Meta', 'Control', 'Shift', 'Alt'];

export function isMacPlatform() {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');
}

export function loadBindings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  return Object.fromEntries(KEYBINDING_ACTIONS.map(action => [action.id, typeof saved[action.id] === 'string' ? saved[action.id] : action.binding]));
}

export function saveBinding(id, binding) {
  const saved = loadBindings();
  saved[id] = binding;
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* binding applies this session only */ }
}

export function resetBindings() {
  try { localStorage.removeItem(KEY); } catch { /* nothing saved */ }
}

function parts(binding) {
  const tokens = binding.split('+');
  const key = tokens.pop() || '';
  return { key: key.toLowerCase(), mod: tokens.includes('mod'), shift: tokens.includes('shift'), alt: tokens.includes('alt') };
}

export function eventMatches(event, binding, mac = isMacPlatform()) {
  if (!binding) return false;
  const want = parts(binding);
  const mod = mac ? event.metaKey : event.ctrlKey;
  return (event.key || '').toLowerCase() === want.key && mod === want.mod
    && Boolean(event.shiftKey) === want.shift && Boolean(event.altKey) === want.alt;
}

// A binding string for the key combination just pressed, or null for a lone modifier.
export function bindingFromEvent(event, mac = isMacPlatform()) {
  if (MODIFIERS.includes(event.key)) return null;
  const tokens = [];
  if (mac ? event.metaKey : event.ctrlKey) tokens.push('mod');
  if (event.shiftKey) tokens.push('shift');
  if (event.altKey) tokens.push('alt');
  tokens.push((event.key || '').toLowerCase());
  return tokens.join('+');
}

export function formatBinding(binding, mac = isMacPlatform()) {
  const { key, mod, shift, alt } = parts(binding || '');
  const label = key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
  if (mac) return `${mod ? '⌘' : ''}${shift ? '⇧' : ''}${alt ? '⌥' : ''}${label}`;
  return [mod && 'Ctrl', shift && 'Shift', alt && 'Alt', label].filter(Boolean).join('+');
}
