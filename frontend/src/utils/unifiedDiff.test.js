import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, splitRows } from './unifiedDiff';

const patch = `--- a/app.js
+++ b/app.js
@@ -1,3 +1,3 @@
 keep
-old
+new
 tail
`;

describe('parseUnifiedDiff', () => {
  it('numbers each line on the side it belongs to', () => {
    expect(parseUnifiedDiff(patch).map(line => [line.kind, line.oldNumber, line.newNumber, line.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,3 @@'],
      ['context', 1, 1, 'keep'],
      ['removed', 2, null, 'old'],
      ['added', null, 2, 'new'],
      ['context', 3, 3, 'tail'],
    ]);
  });

  it('pairs removals with additions for the side-by-side view', () => {
    expect(splitRows(parseUnifiedDiff(patch)).map(row => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['@@ -1,3 +1,3 @@', '@@ -1,3 +1,3 @@'], ['keep', 'keep'], ['old', 'new'], ['tail', 'tail'],
    ]);
  });
});
