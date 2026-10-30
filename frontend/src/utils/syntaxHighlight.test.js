import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINES, highlightLanguage, tokenize } from './syntaxHighlight';

const join = tokens => tokens.map(token => token.text).join('');
const typed = (tokens, type) => tokens.filter(token => token.type === type).map(token => token.text);

describe('tokenize', () => {
  it.each([
    ['js', 'const a = "x"; // note\nlet n = 0x1F;', { keyword: ['const', 'let'], string: ['"x"'], comment: ['// note'], number: ['0x1F'] }],
    ['tsx', 'export const T = <div>{`t${1}`}</div> /* c */', { keyword: ['export', 'const'], comment: ['/* c */'] }],
    ['json', '{"a": [1, true], "b": "c"}', { property: ['"a"', '"b"'], string: ['"c"'], number: ['1'], literal: ['true'] }],
    ['bash', 'if [ -n "$X" ]; then echo $HOME # hi\nfi', { keyword: ['if', 'then', 'echo', 'fi'], variable: ['$HOME'], comment: ['# hi'] }],
    ['python', 'def f(x):\n    """doc\nstring"""\n    return None # c', { keyword: ['def', 'return'], string: ['"""doc\nstring"""'], comment: ['# c'] }],
    ['rust', "fn main<'a>() { let c = 'x'; let s = \"s\"; }", { keyword: ['fn', 'let', 'let'], string: ["'x'", '"s"'] }],
    ['go', 'func main() {\n\tx := `raw\nline`\n}', { keyword: ['func'], string: ['`raw\nline`'] }],
    ['css', '@media (x) { a { color: red; } } /* c */', { keyword: ['@media'], property: ['color'], comment: ['/* c */'] }],
    ['html', '<!-- c --><a href="x">t</a>', { comment: ['<!-- c -->'], tag: ['<a', '</a'], property: ['href'], string: ['"x"'] }],
    ['yaml', 'name: "v"\n# c\nlist:\n  - true', { property: ['name', 'list'], string: ['"v"'], comment: ['# c'], literal: ['true'] }],
    ['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx', { meta: ['--- a', '+++ b', '@@ -1 +1 @@'], deleted: ['-old'], inserted: ['+new'] }],
    ['sql', "SELECT a FROM t WHERE b = 'x' -- c", { keyword: ['SELECT', 'FROM', 'WHERE'], string: ["'x'"], comment: ['-- c'] }],
    ['markdown', '# Title\n> quote\n```js\ncode\n```', { keyword: ['# Title'], comment: ['> quote'] }],
  ])('classifies %s tokens and never loses or alters text', (language, code, expected) => {
    const tokens = tokenize(code, language);
    expect(join(tokens)).toBe(code);
    for (const [type, texts] of Object.entries(expected)) expect(typed(tokens, type)).toEqual(texts);
  });

  it('returns null for unknown languages, non-strings and over-budget inputs', () => {
    expect(tokenize('x', 'brainfuck')).toBeNull();
    expect(tokenize(null, 'js')).toBeNull();
    expect(tokenize('a'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'js')).toBeNull();
    expect(tokenize('a\n'.repeat(HIGHLIGHT_MAX_LINES), 'js')).toBeNull();
    expect(highlightLanguage('TS')).toBe('js');
  });

  it('keeps hostile and unterminated input as plain data and finishes quickly on pathological text', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)> "unterminated \' ` /* open';
    for (const language of ['js', 'html', 'bash', 'python', 'rust', 'sql', 'css', 'yaml', 'json']) expect(join(tokenize(hostile, language))).toBe(hostile);
    const started = performance.now();
    for (const language of ['js', 'html', 'rust', 'python', 'bash', 'yaml']) {
      for (const code of ['"\\'.repeat(9000), "'".repeat(HIGHLIGHT_MAX_CHARS), '<a '.repeat(6000), '/*'.repeat(9000), '\\'.repeat(HIGHLIGHT_MAX_CHARS)]) {
        expect(join(tokenize(code, language))).toBe(code);
      }
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
