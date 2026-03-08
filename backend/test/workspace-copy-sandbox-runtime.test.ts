import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { WorkspaceCopySandboxRuntime } from '../src/sandbox/workspace-copy-sandbox-runtime';

describe('WorkspaceCopySandboxRuntime', () => {
  it('creates an isolated workspace copy and remaps cwd into it', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-v4-sandbox-'));
    const sourceRoot = path.join(tempRoot, 'source-project');
    const nestedDir = path.join(sourceRoot, 'src');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"demo"}', 'utf-8');

    try {
      const runtime = new WorkspaceCopySandboxRuntime(path.join(tempRoot, 'data'));

      const result = runtime.prepareTerminalLaunch({
        sessionId: 'session-1',
        userId: 'user-1',
        shell: 'bash',
        cwd: nestedDir,
        cols: 120,
        rows: 32,
        sandbox: {
          mode: 'workspace-write',
          workspaceRoot: sourceRoot
        }
      });

      expect(result.sandbox).toEqual({
        mode: 'workspace-write',
        workspaceRoot: sourceRoot,
        runtimeId: 'session-1',
        runtimeKind: 'workspace-copy'
      });
      expect(result.cwd).not.toBe(nestedDir);
      expect(result.cwd.endsWith(path.join('workspace', 'src'))).toBe(true);
      expect(fs.existsSync(path.join(path.dirname(result.cwd), 'package.json'))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reuses an existing sandbox workspace instead of overwriting sandbox changes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-v4-sandbox-'));
    const sourceRoot = path.join(tempRoot, 'source-project');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'README.md'), 'host copy', 'utf-8');

    try {
      const runtime = new WorkspaceCopySandboxRuntime(path.join(tempRoot, 'data'));
      const request = {
        sessionId: 'session-2',
        userId: 'user-2',
        shell: 'bash',
        cwd: sourceRoot,
        cols: 120,
        rows: 32,
        sandbox: {
          mode: 'workspace-write' as const,
          workspaceRoot: sourceRoot
        }
      };

      const first = runtime.prepareTerminalLaunch(request);
      fs.writeFileSync(path.join(first.cwd, 'README.md'), 'sandbox copy', 'utf-8');

      const second = runtime.prepareTerminalLaunch(request);

      expect(fs.readFileSync(path.join(second.cwd, 'README.md'), 'utf-8')).toBe('sandbox copy');
      expect(fs.readFileSync(path.join(sourceRoot, 'README.md'), 'utf-8')).toBe('host copy');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
