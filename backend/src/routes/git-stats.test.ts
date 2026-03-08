import { describe, expect, it, vi } from 'vitest';
import { getGitDiffStats, parseGitDiffStat } from './git-stats';

describe('parseGitDiffStat', () => {
  it('parses additions and deletions from git diff --stat output', () => {
    expect(parseGitDiffStat(' 2 files changed, 400 insertions(+), 11 deletions(-)')).toEqual({
      linesAdded: 400,
      linesRemoved: 11,
    });
  });

  it('parses additions-only output', () => {
    expect(parseGitDiffStat(' 1 file changed, 7 insertions(+)')).toEqual({
      linesAdded: 7,
      linesRemoved: 0,
    });
  });
});

describe('getGitDiffStats', () => {
  it('reads local changes against HEAD without trying a branch diff base first', async () => {
    const runGit = vi.fn().mockResolvedValue({
      stdout: ' 1 file changed, 3 insertions(+), 1 deletion(-)'
    });

    const stats = await getGitDiffStats('C:/repo', runGit);

    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith('git', ['diff', '--stat', 'HEAD'], {
      cwd: 'C:/repo',
      timeout: 10000
    });
    expect(stats).toEqual({ linesAdded: 3, linesRemoved: 1 });
  });

  it('falls back to plain git diff when HEAD diff is unavailable', async () => {
    const runGit = vi.fn()
      .mockRejectedValueOnce(new Error('no HEAD'))
      .mockResolvedValueOnce({ stdout: ' 1 file changed, 2 deletions(-)' });

    const stats = await getGitDiffStats('C:/repo', runGit);

    expect(runGit).toHaveBeenNthCalledWith(1, 'git', ['diff', '--stat', 'HEAD'], {
      cwd: 'C:/repo',
      timeout: 10000
    });
    expect(runGit).toHaveBeenNthCalledWith(2, 'git', ['diff', '--stat'], {
      cwd: 'C:/repo',
      timeout: 10000
    });
    expect(stats).toEqual({ linesAdded: 0, linesRemoved: 2 });
  });
});
