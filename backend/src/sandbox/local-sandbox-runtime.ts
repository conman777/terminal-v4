import type {
  SandboxRuntime,
  SandboxTerminalLaunchRequest,
  SandboxTerminalLaunchResult
} from './sandbox-types';

export class LocalSandboxRuntime implements SandboxRuntime {
  readonly kind = 'local-host';

  prepareTerminalLaunch(request: SandboxTerminalLaunchRequest): SandboxTerminalLaunchResult {
    return {
      shell: request.shell,
      cwd: request.cwd,
      env: request.env,
      sandbox: {
        mode: request.sandbox.mode,
        workspaceRoot: request.sandbox.workspaceRoot,
        runtimeId: null,
        runtimeKind: this.kind
      }
    };
  }
}
