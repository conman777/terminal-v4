import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { EventEmitter } from 'node:events';
import type {
  ClaudeCodeEvent,
  ClaudeCodeSession,
  ClaudeModel,
  ManagedClaudeCodeSession
} from './claude-code-types';
import {
  saveClaudeCodeSession,
  loadAllClaudeCodeSessions,
  deleteClaudeCodeSession
} from './claude-code-store';

/**
 * A wrapper around the Claude Code CLI using PTY to maintain compatibility
 * and ensure proper terminal behavior.
 */
class AgentWrapper {
  private currentProcess: ReturnType<typeof ptySpawn> | null = null;

  constructor(private options: any) {}

  /**
   * Kill the current PTY process if one is running.
   */
  kill(signal?: string): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill(signal);
      } catch {
        // Process may already be dead
      }
      this.currentProcess = null;
    }
  }

  async *query(text: string, sessionId?: string) {
    // Kill any existing process before starting a new one
    this.kill();

    const claudePath = process.env.CLAUDE_BIN || 'claude';
    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose'
    ];

    // Add model flag if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.cwd) {
      args.push('--add-dir', this.options.cwd);
    }

    if (this.options.allowedTools) {
      // Claude Code CLI expects comma-separated list for --allowedTools (per docs/dev setup).
      args.push('--allowedTools', this.options.allowedTools.join(','));
    }

    if (sessionId && !sessionId.startsWith('cc-')) {
      args.push('--continue', sessionId);
    }

    if (process.env.CLAUDE_ASSUME_YES === 'true') {
      args.push('--dangerously-skip-permissions');
    }

    const ptyProcess = ptySpawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 160,
      rows: 30,
      cwd: this.options.cwd || process.cwd(),
      env: { ...process.env, ...this.options.env }
    });

    // Store reference for cleanup
    this.currentProcess = ptyProcess;

    const eventEmitter = new EventEmitter();
    const queue: any[] = [];
    let isDone = false;
    let buffer = '';

    // Add error handler to prevent unhandled error crashes
    eventEmitter.on('error', (err) => {
      console.error('[AgentWrapper EventEmitter error]', err);
    });

    // Timeout mechanism - kill process if no activity for 5 minutes
    const QUERY_TIMEOUT_MS = 5 * 60 * 1000;
    let timeoutId: NodeJS.Timeout | null = null;

    const clearQueryTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const resetQueryTimeout = () => {
      clearQueryTimeout();
      timeoutId = setTimeout(() => {
        console.error('[AgentWrapper] Query timeout - killing process');
        this.kill();
        isDone = true;
        eventEmitter.emit('exit');
      }, QUERY_TIMEOUT_MS);
    };

    // Start the timeout
    resetQueryTimeout();

    const stripAnsi = (input: string) =>
      // eslint-disable-next-line no-control-regex
      input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

    ptyProcess.onData((data) => {
      // Reset timeout on activity
      resetQueryTimeout();

      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = stripAnsi(line).trim();
        if (!trimmed) continue;

        // Claude stream-json is one JSON object per line; tolerate leading noise by slicing at braces.
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) continue;

        const jsonString = trimmed.slice(start, end + 1);
        try {
          const message = JSON.parse(jsonString);
          queue.push(message);
          eventEmitter.emit('queued');
        } catch {
          // Noise or partial JSON
        }
      }
    });

    ptyProcess.onExit((e) => {
      // Clear timeout and process reference on exit
      clearQueryTimeout();
      this.currentProcess = null;
      isDone = true;
      eventEmitter.emit('exit');
    });

    while (!isDone || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolvePromise) => {
          const onQueued = () => {
            cleanup();
            resolvePromise();
          };
          const onExit = () => {
            cleanup();
            resolvePromise();
          };
          const cleanup = () => {
            eventEmitter.off('queued', onQueued);
            eventEmitter.off('exit', onExit);
          };

          eventEmitter.on('queued', onQueued);
          eventEmitter.on('exit', onExit);
        });
        continue;
      }

      const msg = queue.shift();
      if (msg) yield msg;
    }
  }
}

export class ClaudeCodeManager {
  #sessions: Map<string, ManagedClaudeCodeSession & { userId: string }> = new Map();
  #apiKey: string;

  constructor(apiKey?: string) {
    this.#apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
  }

  async initialize(): Promise<void> {
    // No-op - sessions are loaded per-user on demand
    console.log('ClaudeCodeManager initialized');
  }

  async loadUserSessions(userId: string): Promise<void> {
    // Load persisted sessions for this user
    const persisted = await loadAllClaudeCodeSessions(userId);
    for (const session of persisted) {
      // Skip if already loaded
      if (this.#sessions.has(session.id)) continue;

      // Default to 'sonnet' for backwards compatibility
      const model = session.model || 'sonnet';

      // Create a new agent for each persisted session
      const agent = new AgentWrapper({
        env: this.#apiKey ? { ANTHROPIC_API_KEY: this.#apiKey } : {},
        cwd: session.cwd,
        model,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
        systemPrompt: 'You are a helpful coding assistant working in a terminal environment.'
      });

      this.#sessions.set(session.id, {
        id: session.id,
        userId,
        cwd: session.cwd,
        model,
        agent,
        events: session.events,
        subscribers: new Set(),
        createdAt: session.createdAt,
        saveTimer: null
      });
    }
    console.log(`Loaded ${persisted.length} persisted Claude Code sessions for user ${userId}`);
  }

  createSession(userId: string, cwd: string, model: ClaudeModel = 'sonnet'): ClaudeCodeSession {
    const id = `cc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Resolve to absolute path for persistence
    const absoluteCwd = resolve(cwd);

    // Create Agent instance
    const agent = new AgentWrapper({
      env: this.#apiKey ? { ANTHROPIC_API_KEY: this.#apiKey } : {},
      cwd: absoluteCwd,
      model,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      systemPrompt: 'You are a helpful coding assistant working in a terminal environment.',
      permissionMode: 'acceptEdits'
    });

    const session: ManagedClaudeCodeSession & { userId: string } = {
      id,
      userId,
      cwd: absoluteCwd,
      model,
      agent,
      events: [],
      subscribers: new Set(),
      createdAt: Date.now(),
      saveTimer: null
    };

    this.#sessions.set(id, session);
    this.#scheduleSave(session);

    return this.#toSnapshot(session);
  }

  // Map CLI events to our event format
  #mapCLIEvent(message: any): ClaudeCodeEvent[] {
    const timestamp = Date.now();
    const events: ClaudeCodeEvent[] = [];

    // The CLI output format matches the SDK SDKMessage format
    if (message.type === 'assistant') {
      const content = message.message.content;
      for (const block of content) {
        const id = `evt-${timestamp}-${Math.random().toString(36).substr(2, 5)}`;
        if (block.type === 'text') {
          events.push({
            id,
            type: 'assistant',
            timestamp,
            content: block.text
          });
        } else if (block.type === 'tool_use') {
          events.push({
            id,
            type: 'tool_use',
            timestamp,
            tool: block.name,
            toolInput: block.input as Record<string, unknown>
          });
        }
      }
    } else if (message.type === 'user' && message.tool_use_result) {
      const id = `evt-${timestamp}-${Math.random().toString(36).substr(2, 5)}`;
      events.push({
        id,
        type: 'tool_result',
        timestamp,
        toolResult: typeof message.tool_use_result === 'string' 
          ? message.tool_use_result 
          : JSON.stringify(message.tool_use_result)
      });
    } else if (message.type === 'result') {
      const id = `evt-${timestamp}-${Math.random().toString(36).substr(2, 5)}`;
      events.push({
        id,
        type: 'result',
        timestamp,
        content: message.subtype === 'success' ? 'Task completed successfully' : `Task failed: ${message.subtype}`
      });
    } else if (message.type === 'system' && message.subtype === 'init') {
      // Store the real session ID from Claude CLI
      if (message.session_id) {
        // We can't easily update the session map key, but we can store it in the session object
        // For now just log it
        console.log('[CLAUDE CLI] Session initialized:', message.session_id);
      }
    }

    return events;
  }

  #notifySubscribers(session: ManagedClaudeCodeSession, event: ClaudeCodeEvent): void {
    for (const subscriber of session.subscribers) {
      try {
        subscriber(event);
      } catch (e) {
        console.error('Subscriber error:', e);
      }
    }
  }

  #scheduleSave(session: ManagedClaudeCodeSession & { userId: string }): void {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
    }
    session.saveTimer = setTimeout(() => {
      void saveClaudeCodeSession(session.userId, this.#toSnapshot(session)).catch((error) => {
        console.error(`Failed to save Claude Code session ${session.id}:`, error);
      });
    }, 2000); // Debounce 2 seconds
  }

  #toSnapshot(session: ManagedClaudeCodeSession): ClaudeCodeSession {
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      events: session.events,
      isActive: true
    };
  }

  getSession(userId: string, id: string): ClaudeCodeSession | null {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) return null;
    return this.#toSnapshot(session);
  }

  getAllSessions(userId: string): ClaudeCodeSession[] {
    return Array.from(this.#sessions.values())
      .filter(s => s.userId === userId)
      .map(s => this.#toSnapshot(s));
  }

  subscribe(userId: string, id: string, handler: (event: ClaudeCodeEvent) => void): () => void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  async sendInput(userId: string, id: string, text: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    // Add user message to events
    const userEvent: ClaudeCodeEvent = {
      id: `evt-${Date.now()}`,
      type: 'user',
      timestamp: Date.now(),
      content: text
    };
    session.events.push(userEvent);
    this.#notifySubscribers(session, userEvent);
    this.#scheduleSave(session);

    try {
      // Query the CLI and stream responses
      // We look for a 'claude_session_id' in the session events to resume
      let cliSessionId = undefined;
      const initEvent = session.events.find(e => e.type === 'result' && (e as any).cli_session_id);
      if (initEvent) cliSessionId = (initEvent as any).cli_session_id;

      for await (const message of session.agent.query(text, cliSessionId)) {
        const events = this.#mapCLIEvent(message);
        
        // If we get an init message, store the CLI session ID
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          // Store it in a way that we can find it later to resume
          const metaEvent: any = {
            id: `meta-${Date.now()}`,
            type: 'result',
            timestamp: Date.now(),
            cli_session_id: message.session_id,
            content: 'Session metadata updated'
          };
          session.events.push(metaEvent);
        }

        for (const event of events) {
          if (process.env.CLAUDE_DEBUG === 'true') {
            console.log('[CLAUDE CLI]', event.type, event.id);
          }
          session.events.push(event);
          this.#notifySubscribers(session, event);
          this.#scheduleSave(session);
        }
      }
    } catch (error) {
      if (process.env.CLAUDE_DEBUG === 'true') {
        console.error('[CLAUDE CLI ERROR]', error);
      } else {
        console.error('[CLAUDE CLI ERROR]', error instanceof Error ? error.message : String(error));
      }
      // Add error event
      const errorEvent: ClaudeCodeEvent = {
        id: `evt-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        isError: true,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`
      };
      session.events.push(errorEvent);
      this.#notifySubscribers(session, errorEvent);
      this.#scheduleSave(session);
      throw error;
    }
  }

  restoreSession(userId: string, id: string): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    return this.#toSnapshot(session);
  }

  stopSession(userId: string, id: string): void {
    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      console.log('[CLAUDE CLI] Stop requested for session', id);
      // Kill the PTY process if running
      if (session.agent && typeof session.agent.kill === 'function') {
        session.agent.kill();
      }
    }
  }

  async deleteSession(userId: string, id: string): Promise<void> {
    this.stopSession(userId, id);
    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      this.#sessions.delete(id);
      await deleteClaudeCodeSession(userId, id);
    }
  }

  updateCwd(userId: string, id: string, cwd: string): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    // Resolve to absolute path
    const absoluteCwd = resolve(cwd);
    session.cwd = absoluteCwd;

    // Kill the old agent's process before creating a new one
    if (session.agent && typeof session.agent.kill === 'function') {
      session.agent.kill();
    }

    // Update agent options with the updated cwd (preserve model)
    session.agent = new AgentWrapper({
      env: this.#apiKey ? { ANTHROPIC_API_KEY: this.#apiKey } : {},
      cwd: absoluteCwd,
      model: session.model,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      systemPrompt: 'You are a helpful coding assistant working in a terminal environment.',
      permissionMode: 'acceptEdits'
    });

    this.#scheduleSave(session);

    return this.#toSnapshot(session);
  }

  updateModel(userId: string, id: string, model: ClaudeModel): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    session.model = model;

    // Kill the old agent's process before creating a new one
    if (session.agent && typeof session.agent.kill === 'function') {
      session.agent.kill();
    }

    // Recreate agent with new model
    session.agent = new AgentWrapper({
      env: this.#apiKey ? { ANTHROPIC_API_KEY: this.#apiKey } : {},
      cwd: session.cwd,
      model,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      systemPrompt: 'You are a helpful coding assistant working in a terminal environment.',
      permissionMode: 'acceptEdits'
    });

    this.#scheduleSave(session);

    return this.#toSnapshot(session);
  }
}
