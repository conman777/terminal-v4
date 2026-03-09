export interface TerminalGitBranchInfo {
  currentBranch: string | null;
  branches: string[];
}

export function parseGitBranchList(output: string): string[] {
  if (typeof output !== 'string' || output.trim().length === 0) return [];

  return Array.from(
    new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );
}
