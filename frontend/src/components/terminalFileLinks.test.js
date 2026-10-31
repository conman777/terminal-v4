import { describe, expect, it } from 'vitest';
import { terminalFileLinks } from './terminalFileLinks';

describe('terminalFileLinks', () => {
  it('finds absolute workspace references and line numbers, including surrounded punctuation', () => {
    expect(terminalFileLinks('error (/work/project/src/a.js:12:4), next /work/project/b.txt#L3.', '/work/project')).toEqual([
      { start: 7, end: 34, file: { path: 'src/a.js', line: 12 } },
      { start: 42, end: 64, file: { path: 'b.txt', line: 3 } },
    ]);
  });
  it('rejects traversal, external URLs, relative and ambiguous paths', () => {
    expect(terminalFileLinks('https://example.test/a.js /work/project/../secret:2 /work/project-other/a.js:1 src/a.js:2 /work/project/a.js, /work/project/a.js.', '/work/project')).toEqual([]);
  });
});
