export const SANDBOX_MODES = ['off', 'read-only', 'workspace-write'] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export interface TerminalSandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string | null;
}

export interface TerminalSandboxInfo extends TerminalSandboxPolicy {
  runtimeId: string | null;
  runtimeKind: string;
}

export interface SandboxTerminalLaunchRequest {
  sessionId: string;
  userId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  sandbox: TerminalSandboxPolicy;
}

export interface SandboxTerminalLaunchResult {
  shell: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sandbox: TerminalSandboxInfo;
}

export interface SandboxRuntime {
  readonly kind: string;
  prepareTerminalLaunch(request: SandboxTerminalLaunchRequest): SandboxTerminalLaunchResult;
  cleanupTerminal?(request: {
    sessionId: string;
    userId: string;
    sandbox: TerminalSandboxInfo;
  }): Promise<void> | void;
}
