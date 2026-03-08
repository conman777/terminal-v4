import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ThreadGitStats } from '../terminal/session-store';

const execFileAsync = promisify(execFile);

export function parseGitDiffStat(output: string): ThreadGitStats | null {
  const match = output.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
  if (match) {
    return { linesAdded: parseInt(match[1], 10), linesRemoved: parseInt(match[2], 10) };
  }

  const insertions = output.match(/(\d+) insertions?\(\+\)/);
  const deletions = output.match(/(\d+) deletions?\(-\)/);
  if (insertions || deletions) {
    return {
      linesAdded: insertions ? parseInt(insertions[1], 10) : 0,
      linesRemoved: deletions ? parseInt(deletions[1], 10) : 0
    };
  }

  return null;
}

export async function getGitDiffStats(
  cwd: string,
  runGit = execFileAsync
): Promise<ThreadGitStats | null> {
  try {
    try {
      const { stdout } = await runGit('git', ['diff', '--stat', 'HEAD'], { cwd, timeout: 10000 });
      return parseGitDiffStat(stdout);
    } catch {
      const { stdout } = await runGit('git', ['diff', '--stat'], { cwd, timeout: 10000 });
      return parseGitDiffStat(stdout);
    }
  } catch {
    return null;
  }
}
