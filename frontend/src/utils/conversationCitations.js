const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FILE_REFERENCE_RE = /^((?:[\w@+~.-]+\/)*[\w@+~.-]+\.[A-Za-z0-9]{1,10})(?::(\d{1,7}))?$/;
const MAX_LINE = 1_000_000;

export function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null;
  } catch { return null; }
}

export function projectRelativePath(path, root) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\0\\]/.test(path)) return null;
  let relative = path;
  if (path.startsWith('/')) {
    const base = typeof root === 'string' ? root.replace(/\/+$/, '') : '';
    if (!base || !path.startsWith(`${base}/`)) return null;
    relative = path.slice(base.length + 1);
  }
  relative = relative.replace(/^(\.\/)+/, '');
  const parts = relative.split('/');
  if (!relative || relative.startsWith('~') || parts.some(part => !part || part === '.' || part === '..')) return null;
  return relative;
}

function lineNumber(value) {
  if (value === undefined || value === '') return null;
  const line = Number(value);
  return Number.isSafeInteger(line) && line >= 1 && line <= MAX_LINE ? line : undefined;
}

export function parseFileReference(text) {
  const match = FILE_REFERENCE_RE.exec(typeof text === 'string' && text.length <= 1100 ? text : '');
  if (!match || (!match[2] && !match[1].includes('/'))) return null;
  const line = lineNumber(match[2]);
  return line === undefined ? null : { path: match[1], line };
}

export function parseCitationTarget(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const thread = /^thread:(.+)$/i.exec(value);
  if (thread) return THREAD_ID_RE.test(thread[1]) ? { kind: 'thread', id: thread[1] } : null;
  const file = /^file:(.+)$/i.exec(value);
  if (file) {
    const reference = FILE_REFERENCE_RE.exec(file[1]) || /^(\/?(?:[^\s:]+\/)*[^\s:]+)(?::(\d{1,7}))?$/.exec(file[1]);
    const line = reference ? lineNumber(reference[2]) : undefined;
    return reference && line !== undefined ? { kind: 'file', path: reference[1], line } : null;
  }
  const href = safeHttpUrl(value);
  return href ? { kind: 'url', href } : null;
}

export function collectCitationDefinitions(blocks, into = new Map()) {
  for (const block of blocks) {
    if (block.type === 'definition') into.set(block.label, block);
    else if (block.type === 'list') block.items.forEach(item => collectCitationDefinitions(item, into));
  }
  return into;
}
