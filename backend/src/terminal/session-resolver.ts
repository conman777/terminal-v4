export type CwdSource = 'session' | 'thread' | 'metadata' | 'default' | 'unknown';

export interface ResolvedSessionPaths {
  cwd: string | null;
  cwdSource: CwdSource;
  groupPath: string | null;
}

export interface ResolveSessionPathsInput {
  cwd: string | null | undefined;
  metadataCwd: string | null | undefined;
  defaultCwd: string;
  homeDir?: string | null;
  threadProjectPath: string | null | undefined;
}

function normalizePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function resolveSessionPaths(input: ResolveSessionPathsInput): ResolvedSessionPaths {
  const normalizedCwd = normalizePath(input.cwd);
  const normalizedMetadataCwd = normalizePath(input.metadataCwd);
  const normalizedDefault = normalizePath(input.defaultCwd) || input.defaultCwd;
  const normalizedProject = normalizePath(input.threadProjectPath);

  let cwd = normalizedCwd;
  let cwdSource: CwdSource = normalizedCwd ? 'session' : 'unknown';

  if (!cwd && normalizedProject) {
    cwd = normalizedProject;
    cwdSource = 'thread';
  }

  if (!cwd && normalizedMetadataCwd) {
    cwd = normalizedMetadataCwd;
    cwdSource = 'metadata';
  }

  if (!cwd && normalizedDefault) {
    cwd = normalizedDefault;
    cwdSource = 'default';
  }

  const groupPath = normalizedProject || cwd || null;

  return {
    cwd,
    cwdSource,
    groupPath
  };
}
