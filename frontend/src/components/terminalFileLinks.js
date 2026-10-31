import { projectFileReference } from '../utils/projectFileReference';

export function terminalFileLinks(text, root) {
  // Restrict to single-width cells so string offsets are xterm columns.
  if (!root || /[^\x20-\x7e]/.test(text)) return [];
  const links = [];
  for (const match of text.matchAll(/\S+/g)) {
    let token = match[0];
    let offset = match.index;
    if (/^[(["']/.test(token)) { token = token.slice(1); offset++; }
    // Only discard prose punctuation when a line suffix makes the boundary clear.
    if (/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)[)\],.;"']+$/i.test(token)) token = token.replace(/[)\],.;"']+$/, '');
    if (!token.startsWith('/')) continue;
    const file = projectFileReference(token, root);
    if (file && !/[),;.]$/.test(token)) links.push({ start: offset, end: offset + token.length, file });
  }
  return links;
}
