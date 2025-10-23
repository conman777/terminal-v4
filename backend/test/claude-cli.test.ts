import { describe, expect, it, vi } from 'vitest';
import { spawnClaudeProcess } from '../src/claude/cli';

describe('spawnClaudeProcess', () => {
  const fakeProcess = {} as any;

  it('constructs CLI command with message payload', () => {
    const spawnMock = vi.fn().mockReturnValue(fakeProcess);
    const result = spawnClaudeProcess({ message: 'Hello Claude', spawnImpl: spawnMock });

    expect(result).toBe(fakeProcess);
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['-p', 'Hello Claude', '--output-format', 'stream-json', '--verbose'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
  });

  it('includes session continuation and allowed tools when provided', () => {
    const spawnMock = vi.fn().mockReturnValue(fakeProcess);

    spawnClaudeProcess({
      message: 'Continue',
      sessionId: 'session-123',
      allowedTools: ['shell', 'editor'],
      spawnImpl: spawnMock
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--continue',
        'session-123',
        '--allowedTools',
        'shell,editor'
      ]),
      expect.any(Object)
    );
  });

  it('enforces non-empty message', () => {
    expect(() => spawnClaudeProcess({ message: '', spawnImpl: vi.fn() })).toThrowError(
      'Claude invocation requires a non-empty message.'
    );
  });
});
