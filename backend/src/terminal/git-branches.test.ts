import { describe, expect, it } from 'vitest';
import { parseGitBranchList } from './git-branches';

describe('parseGitBranchList', () => {
  it('returns normalized unique branch names', () => {
    expect(parseGitBranchList('main\r\nfeature/test\r\nmain\r\n')).toEqual(['main', 'feature/test']);
  });

  it('returns an empty list for empty output', () => {
    expect(parseGitBranchList(' \r\n ')).toEqual([]);
  });
});
