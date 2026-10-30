export const HIGHLIGHT_MAX_CHARS = 20000;
export const HIGHLIGHT_MAX_LINES = 600;

const words = text => new Set(text.split(/\s+/).filter(Boolean));

const JS = words('break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as type interface enum implements readonly public private protected abstract declare namespace satisfies keyof');
const LITERALS = words('true false null undefined NaN Infinity None True False nil');

const C_LIKE = { line: ['//'], block: ['/*', '*/'], quotes: '"\'`', multiline: '`', identExtra: '$' };

const LANGUAGES = {
  js: { ...C_LIKE, keywords: JS },
  json: { quotes: '"', keys: true, keywords: new Set() },
  bash: { line: ['#'], lineAtWordStart: true, quotes: '"\'', multiline: '"\'', variables: true, keywords: words('if then else elif fi for while until do done case esac in function select time return exit export local readonly source alias unset set echo cd') },
  python: { line: ['#'], quotes: '"\'', triple: true, keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self') },
  rust: { line: ['//'], block: ['/*', '*/'], quotes: '"\'', charLiteral: true, multiline: '"', keywords: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while') },
  go: { line: ['//'], block: ['/*', '*/'], quotes: '"\'`', multiline: '`', keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var') },
  css: { block: ['/*', '*/'], quotes: '"\'', hyphenIdent: true, css: true, keywords: new Set() },
  html: { html: true, quotes: '"\'', hyphenIdent: true, keywords: new Set() },
  yaml: { line: ['#'], lineAtWordStart: true, quotes: '"\'', hyphenIdent: true, yaml: true, keywords: new Set() },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: '"\'', foldCase: true, keywords: words('select from where insert into values update set delete create table alter drop index join left right inner outer full on group by order having limit offset as and or not null is in like between distinct union all case when then else end primary key foreign references default unique constraint exists asc desc count sum avg min max') },
  diff: { diff: true },
  markdown: { markdown: true },
};

const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  json: 'json', jsonc: 'json', json5: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  python: 'python', py: 'python', rust: 'rust', rs: 'rust', go: 'go', golang: 'go',
  css: 'css', scss: 'css', html: 'html', xml: 'html', svg: 'html', yaml: 'yaml', yml: 'yaml',
  sql: 'sql', diff: 'diff', patch: 'diff', markdown: 'markdown', md: 'markdown',
};

export function highlightLanguage(language) {
  return ALIASES[String(language || '').toLowerCase()] || null;
}

const isDigit = c => c >= '0' && c <= '9';
const isIdentStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = c => isIdentStart(c) || isDigit(c);
const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function stringEnd(code, start, quote, multiline) {
  let index = start + 1;
  while (index < code.length) {
    const c = code[index];
    if (c === '\\') { index += 2; continue; }
    if (c === quote) return index + 1;
    if (c === '\n' && !multiline) return index;
    index += 1;
  }
  return code.length;
}

function lineEnd(code, from) {
  const end = code.indexOf('\n', from);
  return end === -1 ? code.length : end;
}

function scanDiffOrMarkdown(code, config) {
  const tokens = [];
  let inFence = false;
  for (const line of code.split('\n')) {
    let type = null;
    if (config.diff) {
      if (/^(\+\+\+|---|diff |index )/.test(line)) type = 'meta';
      else if (line.startsWith('@@')) type = 'meta';
      else if (line[0] === '+') type = 'inserted';
      else if (line[0] === '-') type = 'deleted';
    } else if (/^(`{3,}|~{3,})/.test(line)) { inFence = !inFence; type = 'meta'; }
    else if (inFence) type = 'string';
    else if (/^#{1,6}\s/.test(line)) type = 'keyword';
    else if (line[0] === '>') type = 'comment';
    tokens.push({ type, text: line }, { type: null, text: '\n' });
  }
  tokens.pop();
  return tokens;
}

function scan(code, config) {
  const tokens = [];
  const push = (type, start, end) => { if (end > start) tokens.push({ type, text: code.slice(start, end) }); };
  const length = code.length;
  let index = 0, inTag = false;
  const wordStart = () => index === 0 || isSpace(code[index - 1]);

  while (index < length) {
    const c = code[index];

    if (config.html && !inTag) {
      if (code.startsWith('<!--', index)) {
        const close = code.indexOf('-->', index + 4);
        const end = close === -1 ? length : close + 3;
        push('comment', index, end); index = end; continue;
      }
      if (c === '<' && (isIdentStart(code[index + 1] || '') || (code[index + 1] === '/' && isIdentStart(code[index + 2] || '')))) {
        let end = index + (code[index + 1] === '/' ? 2 : 1);
        while (end < length && (isIdentPart(code[end]) || code[end] === '-' || code[end] === ':')) end += 1;
        push('tag', index, end); index = end; inTag = true; continue;
      }
      const next = code.indexOf('<', index + 1);
      const end = next === -1 ? length : next;
      push(null, index, end); index = end; continue;
    }
    if (inTag && c === '>') { push(null, index, index + 1); index += 1; inTag = false; continue; }

    const comment = config.line?.find(prefix => code.startsWith(prefix, index));
    if (comment && (!config.lineAtWordStart || wordStart())) {
      const end = lineEnd(code, index);
      push('comment', index, end); index = end; continue;
    }
    if (config.block && code.startsWith(config.block[0], index)) {
      const close = code.indexOf(config.block[1], index + config.block[0].length);
      const end = close === -1 ? length : close + config.block[1].length;
      push('comment', index, end); index = end; continue;
    }

    if (config.quotes?.includes(c)) {
      if (config.charLiteral && c === "'") {
        const escaped = code[index + 1] === '\\';
        const close = escaped ? code.indexOf("'", index + 3) : (code[index + 2] === "'" ? index + 2 : -1);
        if (close === -1 || close - index > 8) { push(null, index, index + 1); index += 1; continue; }
        push('string', index, close + 1); index = close + 1; continue;
      }
      let end;
      if (config.triple && code.startsWith(c.repeat(3), index)) {
        const close = code.indexOf(c.repeat(3), index + 3);
        end = close === -1 ? length : close + 3;
      } else end = stringEnd(code, index, c, config.multiline?.includes(c));
      let type = 'string';
      if (config.keys) {
        let probe = end;
        while (probe < length && (code[probe] === ' ' || code[probe] === '\t')) probe += 1;
        if (code[probe] === ':') type = 'property';
      }
      push(type, index, end); index = end; continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(code[index + 1] || '') && !isIdentPart(code[index - 1] || ' '))) {
      let end = index + 1;
      while (end < length && (isIdentPart(code[end]) || code[end] === '.')) end += 1;
      push('number', index, end); index = end; continue;
    }

    if (config.variables && c === '$' && (isIdentStart(code[index + 1] || '') || code[index + 1] === '{')) {
      let end = index + 1;
      if (code[end] === '{') { const close = code.indexOf('}', end); end = close === -1 || close - end > 80 ? end + 1 : close + 1; }
      else while (end < length && isIdentPart(code[end])) end += 1;
      push('variable', index, end); index = end; continue;
    }

    if (isIdentStart(c) || (c === '$' && config.identExtra) || (c === '@' && (config.css || config.python))) {
      let end = index + 1;
      while (end < length && (isIdentPart(code[end]) || (config.hyphenIdent && code[end] === '-') || (config.identExtra && code[end] === '$') || (config.html && inTag && code[end] === ':'))) end += 1;
      const word = code.slice(index, end);
      let type = null;
      if (c === '@' && config.css) type = 'keyword';
      else if (inTag) type = 'property';
      else if ((config.foldCase ? config.keywords.has(word.toLowerCase()) : config.keywords.has(word))) type = 'keyword';
      else if (LITERALS.has(word) && !config.css) type = config.yaml || config.keys || config.keywords.size ? 'literal' : null;
      if (!type && (config.yaml || config.css)) {
        let probe = end;
        while (probe < length && (code[probe] === ' ' || code[probe] === '\t')) probe += 1;
        if (code[probe] === ':' && (config.css || isSpace(code[probe + 1] || ' '))) type = 'property';
      }
      if (type === 'keyword' && config.keywords === JS && /^(true|false|null|undefined)$/.test(word)) type = 'literal';
      push(type, index, end); index = end; continue;
    }

    let end = index + 1;
    while (end < length && !isIdentPart(code[end]) && !'"\'`#/-<>$@.'.includes(code[end]) && !(config.quotes || '').includes(code[end])) end += 1;
    push(null, index, end); index = end;
  }
  return tokens;
}

export function tokenize(code, language) {
  const key = highlightLanguage(language);
  if (!key || typeof code !== 'string' || code.length > HIGHLIGHT_MAX_CHARS) return null;
  let lines = 1;
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) {
    lines += 1;
    if (lines > HIGHLIGHT_MAX_LINES) return null;
  }
  const config = LANGUAGES[key];
  const raw = config.diff || config.markdown ? scanDiffOrMarkdown(code, config) : scan(code, config);
  const merged = [];
  for (const token of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === token.type) last.text += token.text;
    else merged.push({ ...token });
  }
  return merged;
}
