import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDir } from '../utils/data-dir';
import { LocalSandboxRuntime } from './local-sandbox-runtime';
import type {
  SandboxRuntime,
  SandboxTerminalLaunchRequest,
  SandboxTerminalLaunchResult
} from './sandbox-types';

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '-');
  return sanitized || 'sandbox';
}

export class WorkspaceCopySandboxRuntime implements SandboxRuntime {
  readonly kind = 'workspace-copy';
  readonly #fallback = new LocalSandboxRuntime();
  readonly #sandboxesRoot: string;

  constructor(baseDir = ensureDataDir()) {
    this.#sandboxesRoot = path.join(baseDir, 'sandboxes');
  }

  prepareTerminalLaunch(request: SandboxTerminalLaunchRequest): SandboxTerminalLaunchResult {
    if (request.sandbox.mode === 'off') {
      return this.#fallback.prepareTerminalLaunch(request);
    }

    const sourceRoot = path.resolve(request.sandbox.workspaceRoot || request.cwd);
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      return this.#fallback.prepareTerminalLaunch(request);
    }

    const sandboxRoot = path.join(
      this.#sandboxesRoot,
      sanitizeSegment(request.userId),
      sanitizeSegment(request.sessionId)
    );
    const workspacePath = path.join(sandboxRoot, 'workspace');
    const metadataPath = path.join(sandboxRoot, 'metadata.json');

    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(sandboxRoot, { recursive: true });
      fs.cpSync(sourceRoot, workspacePath, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      fs.writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            sourceRoot,
            createdAt: new Date().toISOString(),
            mode: request.sandbox.mode
          },
          null,
          2
        ),
        'utf-8'
      );
    }

    const relativeCwd = path.relative(sourceRoot, request.cwd);
    const mappedCwd = !relativeCwd.startsWith('..') && !path.isAbsolute(relativeCwd)
      ? path.join(workspacePath, relativeCwd)
      : workspacePath;

    return {
      shell: request.shell,
      cwd: mappedCwd,
      env: request.env,
      sandbox: {
        mode: request.sandbox.mode,
        workspaceRoot: sourceRoot,
        runtimeId: request.sessionId,
        runtimeKind: this.kind
      }
    };
  }

  cleanupTerminal(request: { sessionId: string; userId: string; sandbox: { runtimeId: string | null } }): void {
    const runtimeId = request.sandbox.runtimeId || request.sessionId;
    const sandboxRoot = path.join(
      this.#sandboxesRoot,
      sanitizeSegment(request.userId),
      sanitizeSegment(runtimeId)
    );

    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}
