import { describe, expect, it } from 'vitest';
import { projectFileReference, validProjectFilePath } from './projectFileReference';

describe('projectFileReference', () => {
  it('resolves relative and workspace-contained absolute file links with line numbers', () => {
    expect([
      projectFileReference('src/app.js:12', '/work/project'),
      projectFileReference('./README.md#L9', '/work/project'),
      projectFileReference('/work/project/src/app.js:3', '/work/project'),
      projectFileReference('package.json', '/work/project'),
      projectFileReference('src/app.js:12:4', '/work/project'),
      projectFileReference('./README.md#L9-L15', '/work/project'),
      projectFileReference('Makefile:3', '/work/project'),
    ]).toEqual([
      { path: 'src/app.js', line: 12 }, { path: 'README.md', line: 9 },
      { path: 'src/app.js', line: 3 }, { path: 'package.json', line: 1 },
      { path: 'src/app.js', line: 12 }, { path: 'README.md', line: 9 }, { path: 'Makefile', line: 3 },
    ]);
  });

  it('does not treat external links, traversal, out-of-workspace paths or invalid lines as project files', () => {
    const inputs = ['https://example.test/a.js', '/work/project-other/a.js:4', '../secrets.txt', 'src/../secret.txt',
      'file:///work/project/a.js', 'a.js:0', 'a.js:1000001', 'a.js:2:0', 'a.js:1:2:3', 'a.js#L10-L3', 'a.js?x=1', 'a%2fb.js', 'a\\b.js', 'not-a-file'];
    expect(inputs.map(value => projectFileReference(value, '/work/project'))).toEqual(inputs.map(() => null));
  });
});

describe('validProjectFilePath', () => {
  it('accepts literal project filenames while rejecting traversal, controls and excessive byte lengths', () => {
    const paths = ['src/a?#%.txt', 'src/name:2', 'Makefile', '../secret', 'src/../secret', '/outside', 'src\\file', 'a\u0085b', 'é'.repeat(1025), '\ud800'];
    expect(paths.map(path => validProjectFilePath(path, '/work/project'))).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(validProjectFilePath('src/file', 'relative-root')).toBe(false);
  });
});
