import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { terminalNavigationCommand } from './terminalNavigation';

describe('terminalNavigationCommand', () => {
  it.each(['/bin/sh', '/bin/bash', '/bin/zsh'])('preserves literal metacharacters in %s', shell => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-navigation-'));
    try {
      const path = join(realpathSync(root), '$(touch SUBSTITUTION_MARKER)`touch BACKTICK_MARKER` $HOME "double" single\'quote');
      mkdirSync(path);
      const command = terminalNavigationCommand(path, shell).replace(/\r$/, '');
      const result = spawnSync(shell, [...(shell.endsWith('zsh') ? ['-f'] : []), '-c', `${command} && pwd`], { cwd: root, encoding: 'utf8' });
      expect({ status: result.status, cwd: result.stdout.trim(), substitution: existsSync(join(root, 'SUBSTITUTION_MARKER')), backtick: existsSync(join(root, 'BACKTICK_MARKER')) })
        .toEqual({ status: 0, cwd: path, substitution: false, backtick: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses PowerShell literal-path syntax and doubles single quotes', () => {
    expect(terminalNavigationCommand("C:\\work\\a'b $HOME `literal` [wildcard]", 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
      .toBe("Set-Location -LiteralPath 'C:\\work\\a''b $HOME `literal` [wildcard]'\r");
  });

  it.each(['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'unknown', undefined])('rejects unsupported shells explicitly (%s)', shell => {
    expect(() => terminalNavigationCommand('C:\\work\\%PATH% & literal', shell)).toThrow('unavailable for this shell');
  });

  it.each(['line\nbreak', 'carriage\rreturn', 'null\0byte'])('rejects terminal control characters', path => {
    expect(() => terminalNavigationCommand(path, '/bin/sh')).toThrow('control characters');
  });
});
