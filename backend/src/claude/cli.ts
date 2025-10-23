import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface SpawnClaudeOptions {
  message: string;
  sessionId?: string;
  allowedTools?: string[];
  assumeYes?: boolean;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

function normaliseAllowedTools(allowed: string[] | undefined): string[] {
  if (!Array.isArray(allowed)) {
    return [];
  }

  return allowed.map((tool) => tool.trim()).filter(Boolean);
}

export function spawnClaudeProcess(options: SpawnClaudeOptions): ChildProcessWithoutNullStreams {
  const message = options.message?.trim();
  if (!message) {
    throw new Error('Claude invocation requires a non-empty message.');
  }

  const args: string[] = ['-p', message, '--output-format', 'stream-json', '--verbose'];

  if (options.sessionId) {
    args.push('--continue', options.sessionId);
  }

  const allowedTools = normaliseAllowedTools(options.allowedTools);
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  if (options.assumeYes || process.env.CLAUDE_ASSUME_YES === 'true') {
    args.push('--dangerously-skip-permissions');
  }

  const env = {
    ...process.env,
    ...options.env
  };

  const command = options.cliPath ?? process.env.CLAUDE_BIN ?? 'claude';
  const spawnFn = options.spawnImpl ?? spawn;

  return spawnFn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
