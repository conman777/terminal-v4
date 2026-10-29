import { parsePlan } from './conversationWork';

const groups = new WeakMap();
const legacyKeys = new WeakMap();
const searchableText = new WeakMap();
let nextLegacyKey = 0;

export const FOLDED_SEARCH_CHANGED = 'v4-folded-search-changed';

export function foldedMessageKey(item) {
  if (item.toolCallId) return `${item.role}:${item.toolCallId}`;
  if (item.messageId) return `${item.role}:${item.messageId}`;
  const identity = item.original || item;
  let key = legacyKeys.get(identity);
  if (!key) { key = `legacy:${++nextLegacyKey}`; legacyKeys.set(identity, key); }
  return `${item.role}:${key}`;
}

export function registerFoldedSearchGroup(element, items) {
  groups.set(element, items);
  element.dispatchEvent(new Event(FOLDED_SEARCH_CHANGED, { bubbles: true }));
  return () => groups.delete(element);
}

export function foldedSearchItems(element) {
  return groups.get(element) || [];
}

export function foldedMessageMatches(item, needle) {
  if (typeof item?.content !== 'string') return false;
  if (item.searchText?.some(text => text.toLowerCase().includes(needle))) return true;
  const cached = searchableText.get(item);
  if (cached?.source === item.content) return cached.raw.includes(needle) || (!['tool', 'plan'].includes(item.role) && cached.plain.includes(needle));
  const plan = item.role === 'plan' ? parsePlan(item.content) : null;
  if (item.role === 'plan' && !plan) return false;
  const source = plan ? [plan.explanation, ...plan.steps.map(step => step.step)].join('\n') : item.content;
  let plain = '', start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '[') continue;
    const close = source.indexOf(']', index + 1);
    if (close < 0) break;
    if (source[close + 1] !== '(') { index = close; continue; }
    let depth = 1, end = close + 2;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === '\\') { end += 1; continue; }
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
    }
    if (depth !== 0) break;
    plain += source.slice(start, index) + source.slice(index + 1, close);
    start = end;
    index = end - 1;
  }
  plain = (plain + source.slice(start)).replaceAll('**', '').replaceAll('`', '').toLowerCase();
  const entry = { source: item.content, raw: source.toLowerCase(), plain };
  searchableText.set(item, entry);
  return entry.raw.includes(needle) || (!['tool', 'plan'].includes(item.role) && entry.plain.includes(needle));
}
