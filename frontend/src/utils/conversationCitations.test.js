import { describe, expect, it } from 'vitest';
import { collectCitationDefinitions, parseCitationTarget, parseFileReference, projectRelativePath, safeHttpUrl } from './conversationCitations';

describe('safeHttpUrl', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://', '//evil.test', 'x'.repeat(3000)])('rejects %s', value => {
    expect(safeHttpUrl(value)).toBeNull();
  });
  it('accepts http and https', () => {
    expect(safeHttpUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1');
    expect(safeHttpUrl('http://example.test')).toBe('http://example.test/');
  });
});

describe('projectRelativePath', () => {
  it.each([
    ['src/a.js', '/p', 'src/a.js'],
    ['./src/a.js', '/p', 'src/a.js'],
    ['/p/src/a.js', '/p/', 'src/a.js'],
  ])('maps %s inside %s', (path, root, expected) => expect(projectRelativePath(path, root)).toBe(expected));
  it.each([['../a.js', '/p'], ['/other/a.js', '/p'], ['/pp/a.js', '/p'], ['/p/../x', '/p'], ['a\\b', '/p'], ['a/\0', '/p'], ['~/a', '/p'], ['a//b', '/p'], ['/etc/passwd', undefined], ['', '/p']])('rejects %s', (path, root) => {
    expect(projectRelativePath(path, root)).toBeNull();
  });
});

describe('parseFileReference', () => {
  it('reads path and optional line', () => {
    expect(parseFileReference('src/App.jsx:42')).toEqual({ path: 'src/App.jsx', line: 42 });
    expect(parseFileReference('src/App.jsx')).toEqual({ path: 'src/App.jsx', line: null });
    expect(parseFileReference('App.jsx:7')).toEqual({ path: 'App.jsx', line: 7 });
  });
  it.each(['App.jsx', 'npm', 'v1.2', 'src/a.js:0', 'src/a.js:99999999', 'a b/c.js:1', 'http://x.test/a.js:1'])('ignores %s', text => {
    expect(parseFileReference(text)).toBeNull();
  });
});

describe('parseCitationTarget', () => {
  it('classifies urls, threads and files', () => {
    expect(parseCitationTarget('https://example.test/')).toEqual({ kind: 'url', href: 'https://example.test/' });
    expect(parseCitationTarget('thread:abc-123')).toEqual({ kind: 'thread', id: 'abc-123' });
    expect(parseCitationTarget('file:src/a.rs:9')).toEqual({ kind: 'file', path: 'src/a.rs', line: 9 });
    expect(parseCitationTarget('file:/abs/p/a.rs')).toEqual({ kind: 'file', path: '/abs/p/a.rs', line: null });
  });
  it.each(['javascript:alert(1)', 'thread:../x', 'thread:', 'file:', 'file:a.js:0', 'vbscript:x', null, 42])('refuses %s', value => {
    expect(parseCitationTarget(value)).toBeNull();
  });
});

describe('collectCitationDefinitions', () => {
  it('finds definitions inside nested lists', () => {
    const map = collectCitationDefinitions([{ type: 'list', items: [[{ type: 'definition', label: '1' }]] }, { type: 'definition', label: '2' }]);
    expect([...map.keys()]).toEqual(['1', '2']);
  });
  it('finds definitions in structured list items and nested alerts', () => {
    const map = collectCitationDefinitions([{ type: 'list', items: [{ blocks: [{ type: 'alert', blocks: [{ type: 'definition', label: '1' }] }] }] }]);
    expect([...map.keys()]).toEqual(['1']);
  });
});
