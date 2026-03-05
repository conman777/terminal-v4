import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { ProviderAdapter, ProviderProcess, ProviderCapabilities, SpawnOptions } from '../adapter';
import type { CanonicalEvent } from '../canonical-events';
import { makeEvent, nextSeq } from '../canonical-events';

/**
 * Adapter for Claude Code CLI (`claude -p --output-format stream-json`).
 * Spawns via pipes (NOT PTY) for clean JSON output.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly providerId = 'claude';
  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsApproval: true,
    supportsInterrupt: true,
  };

  spawn(options: SpawnOptions): ProviderProcess {
    return new ClaudeProcess(options);
  }
}

class ClaudeProcess implements ProviderProcess {
  private child: ChildProcess | null = null;
  private emitter = new EventEmitter();
  private queue: CanonicalEvent[] = [];
  private done = false;
  private accumulatedText = '';
  private currentToolName: string | null = null;

  constructor(private options: SpawnOptions) {
    this.emitter.setMaxListeners(20);
    this.start();
  }

  private start(): void {
    const isWindows = process.platform === 'win32';
    const claudePath = process.env.CLAUDE_BIN || (isWindows ? 'claude.cmd' : 'claude');
    const args = [
      '-p', this.options.prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.cwd) {
      args.push('--add-dir', this.options.cwd);
    }

    if (this.options.sessionId) {
      args.push('--continue', this.options.sessionId);
    }

    if (process.env.CLAUDE_ASSUME_YES === 'true') {
      args.push('--dangerously-skip-permissions');
    }

    const env = { ...process.env, ...this.options.env };

    this.child = spawn(claudePath, args, {
      cwd: this.options.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, spawn .cmd files via shell
      shell: isWindows,
    });

    // Read stdout line-by-line (NDJSON)
    const rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return;

      try {
        const message = JSON.parse(trimmed.slice(start, end + 1));
        const events = this.mapCliMessage(message);
        for (const event of events) {
          this.queue.push(event);
          this.emitter.emit('queued');
        }
      } catch {
        // Not valid JSON — skip
      }
    });

    // Capture stderr for debugging
    this.child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text && process.env.CLAUDE_DEBUG === 'true') {
        console.error('[claude-adapter stderr]', text);
      }
    });

    this.child.on('error', (err) => {
      const errorEvent = makeEvent<CanonicalEvent>({
        type: 'error',
        message: `Process error: ${err.message}`,
      });
      this.queue.push(errorEvent);
      this.done = true;
      this.emitter.emit('queued');
      this.emitter.emit('exit');
    });

    this.child.on('close', (code) => {
      // Emit session_ended
      const endEvent = makeEvent<CanonicalEvent>({
        type: 'session_ended',
        sessionId: this.options.sessionId || 'unknown',
        reason: code === 0 ? 'completed' : 'error',
      });
      this.queue.push(endEvent);
      this.done = true;
      this.child = null;
      this.emitter.emit('queued');
      this.emitter.emit('exit');
    });
  }

  /**
   * Map a Claude CLI stream-json message to canonical events.
   */
  private mapCliMessage(message: any): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];

    if (message.type === 'system' && message.subtype === 'init') {
      events.push(
        makeEvent({
          type: 'session_started',
          sessionId: message.session_id || 'unknown',
          provider: 'claude',
        })
      );
      return events;
    }

    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (!Array.isArray(content)) return events;

      for (const block of content) {
        if (block.type === 'text') {
          this.accumulatedText += block.text;
          events.push(
            makeEvent({
              type: 'message_delta',
              role: 'assistant',
              content: block.text,
            })
          );
        } else if (block.type === 'tool_use') {
          this.currentToolName = block.name;
          events.push(
            makeEvent({
              type: 'tool_started',
              toolName: block.name,
              toolInput: block.input || {},
              toolCallId: block.id,
            })
          );
        }
      }
      return events;
    }

    if (message.type === 'user' && message.tool_use_result !== undefined) {
      const toolResult =
        typeof message.tool_use_result === 'string'
          ? message.tool_use_result
          : JSON.stringify(message.tool_use_result);

      events.push(
        makeEvent({
          type: 'tool_completed',
          toolName: this.currentToolName || 'unknown',
          result: toolResult,
          isError: Boolean(message.is_error),
        })
      );
      this.currentToolName = null;
      return events;
    }

    if (message.type === 'result') {
      // Emit the final completed message with all accumulated text
      if (this.accumulatedText) {
        events.push(
          makeEvent({
            type: 'message_completed',
            role: 'assistant',
            content: this.accumulatedText,
          })
        );
        this.accumulatedText = '';
      }

      if (message.subtype !== 'success') {
        events.push(
          makeEvent({
            type: 'error',
            message: `CLI result: ${message.subtype}`,
          })
        );
      }
      return events;
    }

    // Anything else → raw escape hatch
    events.push(
      makeEvent({
        type: 'raw_provider_event',
        provider: 'claude',
        data: message,
      })
    );

    return events;
  }

  get events(): AsyncIterable<CanonicalEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<CanonicalEvent>> {
            while (!self.done || self.queue.length > 0) {
              if (self.queue.length > 0) {
                return { value: self.queue.shift()!, done: false };
              }
              await new Promise<void>((resolve) => {
                const onQueued = () => { cleanup(); resolve(); };
                const onExit = () => { cleanup(); resolve(); };
                const cleanup = () => {
                  self.emitter.off('queued', onQueued);
                  self.emitter.off('exit', onExit);
                };
                self.emitter.once('queued', onQueued);
                self.emitter.once('exit', onExit);
              });
            }
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }

  sendInput(text: string): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(text);
    }
  }

  sendApproval(approved: boolean): void {
    // Claude CLI expects y/n on stdin for approval prompts
    this.sendInput(approved ? 'y\n' : 'n\n');
  }

  interrupt(): void {
    if (this.child) {
      this.child.kill('SIGINT');
    }
  }

  kill(): void {
    if (this.child) {
      const pid = this.child.pid;
      try {
        this.child.kill('SIGTERM');
      } catch { /* already dead */ }
      if (pid && process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch { /* group already dead */ }
      }
      this.child = null;
    }
    this.done = true;
    this.emitter.emit('exit');
  }
}
