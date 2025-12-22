import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClaudeCodeEvent } from '../claude-code/claude-code-types';

export interface ClaudeCliArgsOptions {
  message: string;
  resumeSessionId?: string | null;
  assumeYes?: boolean;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
}

export function buildClaudeArgs(options: ClaudeCliArgsOptions): string[] {
  const args: string[] = [];

  // Print mode: `claude -p "<message>" ...`
  args.push('-p', options.message);

  // Structured streaming output
  args.push('--output-format', 'stream-json');

  // Required by Claude Code CLI when using --print with stream-json output
  args.push('--verbose');

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  const allowedTools = (options.allowedTools ?? []).filter(Boolean);
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  const disallowedTools = (options.disallowedTools ?? []).filter(Boolean);
  if (disallowedTools.length > 0) {
    args.push('--disallowedTools', disallowedTools.join(','));
  }

  if (options.assumeYes) {
    args.push('--dangerously-skip-permissions');
  }

  return args;
}

export type SpawnImpl = typeof spawn;

export interface SpawnClaudeProcessOptions extends ClaudeCliArgsOptions {
  cwd: string;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnImpl;
}

export function spawnClaudeProcess(options: SpawnClaudeProcessOptions): ChildProcessWithoutNullStreams {
  const claudeBin = options.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const spawnImpl = options.spawnImpl ?? spawn;

  const args = buildClaudeArgs(options);
  const child = spawnImpl(claudeBin, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'pipe'
  }) as unknown as ChildProcessWithoutNullStreams;

  return child;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeEvent(base: Omit<ClaudeCodeEvent, 'id' | 'timestamp'>): ClaudeCodeEvent {
  return {
    id: `evt-${randomUUID()}`,
    timestamp: Date.now(),
    ...base
  };
}

export interface StreamClaudeCliOptions extends SpawnClaudeProcessOptions {
  abortSignal?: AbortSignal;
}

export async function* streamClaudeCliEvents(
  options: StreamClaudeCliOptions
): AsyncGenerator<{ events: ClaudeCodeEvent[]; sessionId?: string }, void, void> {
  const child = spawnClaudeProcess(options);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderrBuffer = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });

  const abort = () => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  };

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      abort();
    } else {
      options.abortSignal.addEventListener('abort', abort, { once: true });
    }
  }

  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const { events, sessionId } = mapClaudeCliLineToEvents(parsed);
        if (events.length > 0 || sessionId) {
          yield { events, sessionId };
        }
      } catch {
        // Non-JSON noise: keep UI stable by ignoring it unless stderr ends up containing errors.
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    try {
      const parsed = JSON.parse(trailing) as unknown;
      const { events, sessionId } = mapClaudeCliLineToEvents(parsed);
      if (events.length > 0 || sessionId) {
        yield { events, sessionId };
      }
    } catch {
      // ignore
    }
  }

  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });

  if (stderrBuffer.trim()) {
    yield {
      events: [
        makeEvent({
          type: 'system',
          content: `Claude CLI stderr:\n${stderrBuffer.trim()}`
        })
      ]
    };
  }
}

export function mapClaudeCliLineToEvents(line: unknown): {
  events: ClaudeCodeEvent[];
  sessionId?: string;
} {
  if (!isRecord(line)) return { events: [] };

  const type = typeof line.type === 'string' ? line.type : '';
  const sessionId = typeof line.session_id === 'string' ? line.session_id : undefined;

  if (type === 'system' && line.subtype === 'init') {
    const model = typeof line.model === 'string' ? line.model : undefined;
    const content = model
      ? `Session initialized with model: ${model}`
      : 'Session initialized';
    return { sessionId, events: [makeEvent({ type: 'system', content })] };
  }

  if (type === 'assistant') {
    const message = isRecord(line.message) ? line.message : null;
    const contentBlocks = Array.isArray(message?.content) ? message?.content : [];
    const events: ClaudeCodeEvent[] = [];

    const textParts: string[] = [];
    const toolUses: Array<{ name: string; input: Record<string, unknown> }> = [];

    for (const block of contentBlocks) {
      if (!isRecord(block)) continue;
      const blockType = typeof block.type === 'string' ? block.type : '';

      if (blockType === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }

      if (blockType === 'tool_use' && typeof block.name === 'string') {
        const input = isRecord(block.input) ? (block.input as Record<string, unknown>) : {};
        toolUses.push({ name: block.name, input });
      }
    }

    const text = textParts.join('');
    if (text.trim().length > 0) {
      events.push(makeEvent({ type: 'assistant', content: text }));
    }

    // Important for frontend grouping: emit tool_use events without anything between tool_use and tool_result.
    for (const toolUse of toolUses) {
      events.push(
        makeEvent({
          type: 'tool_use',
          tool: toolUse.name,
          toolInput: toolUse.input
        })
      );
    }

    return { sessionId, events };
  }

  if (type === 'user') {
    const message = isRecord(line.message) ? line.message : null;
    const contentBlocks = Array.isArray(message?.content) ? message?.content : [];
    const events: ClaudeCodeEvent[] = [];

    const toolUseResult = isRecord(line.tool_use_result) ? line.tool_use_result : null;
    const toolUseStdout = toolUseResult && typeof toolUseResult.stdout === 'string' ? toolUseResult.stdout : '';
    const toolUseStderr = toolUseResult && typeof toolUseResult.stderr === 'string' ? toolUseResult.stderr : '';

    for (const block of contentBlocks) {
      if (!isRecord(block)) continue;
      if (block.type !== 'tool_result') continue;

      const isError = Boolean(block.is_error);

      let toolResultText = '';
      if (toolUseStdout || toolUseStderr) {
        toolResultText = toolUseStdout;
        if (toolUseStderr) {
          toolResultText = toolResultText
            ? `${toolResultText}\n${toolUseStderr}`
            : toolUseStderr;
        }
      } else if (typeof block.content === 'string') {
        toolResultText = block.content;
      } else if (block.content !== undefined) {
        toolResultText = JSON.stringify(block.content);
      }

      events.push(makeEvent({ type: 'tool_result', toolResult: toolResultText, isError }));
    }

    return { sessionId, events };
  }

  if (type === 'result') {
    const isError = Boolean(line.is_error) || (typeof line.subtype === 'string' && line.subtype !== 'success');
    const resultText = typeof line.result === 'string' ? line.result : '';
    const events: ClaudeCodeEvent[] = [];

    if (isError) {
      const message = resultText || 'Claude CLI returned an error';
      events.push(makeEvent({ type: 'system', content: `Error: ${message}` }));
    }

    // Frontend ignores rendering `result` (to avoid duplication), but uses it to clear isProcessing.
    events.push(
      makeEvent({
        type: 'result',
        content: resultText || (isError ? 'Error' : 'Completed successfully')
      })
    );

    return { sessionId, events };
  }

  // Ignore noisy stream_event wrappers unless we later add true streaming support.
  return { sessionId, events: [] };
}


