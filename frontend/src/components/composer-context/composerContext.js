export const MAX_CONTEXT_CHARS = 8000;
const MAX_LABEL = 120;
const SAFE_ID = /^[\w.:-]{1,128}$/;
const KINDS = ['terminal', 'thread', 'pr'];
const CLOSE = '</composer-context';
const ESCAPED_CLOSE = '<\\/composer-context';
const BLOCK = /^<composer-context kind="(terminal|thread|pr)" label="([^"]*)"(?: id="([^"]*)")?(?: truncated="true")?>\n([\s\S]*?)\n<\/composer-context>\n?/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/(\b[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|credential)[\w.-]*\s*[=:]\s*)(?!\[redacted\])["']?[^\s"']+["']?/gi, '$1[redacted]'],
];

export function redactSecrets(text) {
  return SECRET_RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text ?? '').replace(ANSI, ''));
}

function cleanLabel(value, fallback) {
  const label = String(value ?? '').replace(/["<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return label || fallback;
}

export function buildTerminalContext({ text, label = 'Terminal output' }) {
  const lines = redactSecrets(text).replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length || !lines.some(line => line.trim())) return null;
  const total = lines.length;
  let kept = lines.slice();
  while (kept.join('\n').length > MAX_CONTEXT_CHARS && kept.length > 1) kept.shift();
  let body = kept.join('\n');
  if (body.length > MAX_CONTEXT_CHARS) body = body.slice(body.length - MAX_CONTEXT_CHARS);
  const first = total - kept.length + 1;
  const range = total === 1 ? 'line 1' : `lines ${first}-${total}`;
  return { kind: 'terminal', label: `${cleanLabel(label, 'Terminal output')} · ${range}`, body, truncated: kept.length < total || body.length < kept.join('\n').length };
}

const WEB_URL = /^https?:\/\/[^\s"<>]{1,300}$/;

function buildReference(kind, noun, { id, title, url }) {
  const key = String(id ?? '');
  if (!SAFE_ID.test(key)) return null;
  const label = cleanLabel(title, key);
  const link = typeof url === 'string' && WEB_URL.test(url) ? ` URL: ${url}` : '';
  return { kind, id: key, label, body: `Reference to ${noun} "${label}" (id ${key}).${link}` };
}

export const buildThreadContext = thread => buildReference('thread', 'another thread of this user', thread);
export const buildPullRequestContext = pr => buildReference('pr', 'a pull request', pr);

function serialize(chip) {
  const body = String(chip.body ?? '').split(CLOSE).join(ESCAPED_CLOSE);
  const label = cleanLabel(chip.label, chip.kind);
  const id = chip.id && SAFE_ID.test(chip.id) ? ` id="${chip.id}"` : '';
  return `<composer-context kind="${chip.kind}" label="${label}"${id}${chip.truncated ? ' truncated="true"' : ''}>\n${body}\n${CLOSE}>\n`;
}

export function splitContext(value) {
  let rest = typeof value === 'string' ? value : '';
  const chips = [];
  for (let match = BLOCK.exec(rest); match && KINDS.includes(match[1]); match = BLOCK.exec(rest)) {
    chips.push({ kind: match[1], label: match[2], ...(match[3] ? { id: match[3] } : {}), body: match[4].split(ESCAPED_CLOSE).join(CLOSE),
      ...(match[0].includes(' truncated="true">') ? { truncated: true } : {}) });
    rest = rest.slice(match[0].length);
  }
  return { chips, text: rest };
}

export function joinContext(chips, text) {
  return `${chips.map(serialize).join('')}${text ?? ''}`;
}

export function addContext(value, chip) {
  if (!chip) return value;
  const { chips, text } = splitContext(value);
  if (chip.id && chips.some(existing => existing.kind === chip.kind && existing.id === chip.id)) return value;
  return joinContext([...chips, chip], text);
}

export function removeContext(value, index) {
  const { chips, text } = splitContext(value);
  return joinContext(chips.filter((_, position) => position !== index), text);
}

export function redactContextBlocks(value) {
  const { chips, text } = splitContext(value);
  return joinContext(chips.map(chip => (chip.kind === 'terminal' ? { ...chip, body: redactSecrets(chip.body).slice(-MAX_CONTEXT_CHARS) } : chip)), text);
}
