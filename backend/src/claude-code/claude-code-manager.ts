import { randomUUID } from 'node:crypto';
import { spawn as ptySpawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type {
  ClaudeCodeEvent,
  ClaudeCodeSession,
  ManagedClaudeCodeSession
} from './claude-code-types';
import {
  saveClaudeCodeSession,
  loadAllClaudeCodeSessions,
  deleteClaudeCodeSession
} from './claude-code-store';

export class ClaudeCodeManager {
  #sessions: Map<string, ManagedClaudeCodeSession> = new Map();
  #initialized = false;
  // Track Claude session IDs for conversation continuity
  #claudeSessionIds: Map<string, string> = new Map();

  async initialize(): Promise<void> {
    if (this.#initialized) return;

    // Load persisted sessions on startup
    const persisted = await loadAllClaudeCodeSessions();
    for (const session of persisted) {
      this.#sessions.set(session.id, {
        id: session.id,
        cwd: session.cwd,
        process: null, // Not active until restored
        events: session.events,
        subscribers: new Set(),
        createdAt: session.createdAt,
        saveTimer: null
      });
    }
    this.#initialized = true;
    console.log(`Loaded ${persisted.length} persisted Claude Code sessions`);
  }

  createSession(cwd: string): ClaudeCodeSession {
    const id = `cc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // Generate a UUID for Claude CLI session continuity
    const claudeSessionId = randomUUID();
    this.#claudeSessionIds.set(id, claudeSessionId);

    const session: ManagedClaudeCodeSession = {
      id,
      cwd,
      process: null,
      events: [],
      subscribers: new Set(),
      createdAt: Date.now(),
      saveTimer: null
    };

    this.#sessions.set(id, session);
    this.#scheduleSave(session);

    return this.#toSnapshot(session);
  }

  // Run Claude with a prompt and stream output
  #runClaudeWithPrompt(session: ManagedClaudeCodeSession, prompt: string): void {
    const claudeSessionId = this.#claudeSessionIds.get(session.id);

    // Build args with session ID for conversation continuity
    const args = [
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', prompt
    ];

    if (claudeSessionId) {
      args.push('--session-id', claudeSessionId);
    }

    console.log('[CLAUDE] Spawning with args:', args.join(' '));

    // Use node-pty to create a proper PTY - Claude CLI may require TTY for output
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const shellArgs = process.platform === 'win32'
      ? ['/c', 'claude', ...args]
      : ['-c', `claude ${args.join(' ')}`];

    console.log('[CLAUDE] Using PTY with shell:', shell, shellArgs.join(' '));

    const proc = ptySpawn(shell, shellArgs, {
      name: 'dumb', // Use dumb terminal to avoid cursor positioning escape sequences
      cols: 300,    // Wide enough to avoid line wrapping
      rows: 100,
      cwd: session.cwd,
      env: {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0'
      } as Record<string, string>
    });

    console.log('[CLAUDE] PTY spawned, pid:', proc.pid);

    session.process = proc;

    let buffer = '';

    // Regex to strip ANSI escape sequences
    const stripAnsi = (str: string): string => {
      // eslint-disable-next-line no-control-regex
      return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '');
    };

    proc.onData((data: string) => {
      // Strip ANSI escape sequences before processing
      const cleanData = stripAnsi(data);
      console.log('[CLAUDE PTY] Received:', data.length, 'chars, cleaned:', cleanData.length);

      buffer += cleanData;

      // Parse newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            console.log('[CLAUDE PARSED]', parsed.type || 'no-type');
            const result = this.#parseClaudeEvent(parsed);
            if (result) {
              // Handle single event or array of events
              const events = Array.isArray(result) ? result : [result];
              for (const event of events) {
                console.log('[CLAUDE EVENT]', event.type, event.id);
                session.events.push(event);
                this.#notifySubscribers(session, event);
              }
              this.#scheduleSave(session);
            }
          } catch (e) {
            // Not valid JSON, might be shell prompt or other output
            console.log('[CLAUDE] Non-JSON line:', trimmed.substring(0, 100));
          }
        }
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log('[CLAUDE] PTY exited with code:', exitCode, 'signal:', signal);
      session.process = null;
      this.#scheduleSave(session);
    });
  }

  #parseClaudeEvent(raw: unknown): ClaudeCodeEvent | ClaudeCodeEvent[] | null {
    // Parse the stream-json format from Claude Code CLI
    // The format varies based on event type

    const obj = raw as Record<string, unknown>;
    const timestamp = Date.now();

    // Handle different event types from Claude Code CLI
    const eventType = obj.type as string;

    if (eventType === 'assistant') {
      // Assistant message content - may contain multiple blocks
      const message = obj.message as Record<string, unknown> | undefined;
      const events: ClaudeCodeEvent[] = [];

      if (message?.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (typeof block === 'object' && block !== null) {
            const blockObj = block as Record<string, unknown>;

            // Handle text blocks
            if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
              events.push({
                id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                type: 'assistant',
                timestamp,
                content: blockObj.text
              });
            }

            // Handle tool_use blocks embedded in assistant messages
            if (blockObj.type === 'tool_use') {
              events.push({
                id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                type: 'tool_use',
                timestamp,
                tool: String(blockObj.name || ''),
                toolInput: (blockObj.input || {}) as Record<string, unknown>
              });
            }
          }
        }
      } else if (message?.content && typeof message.content === 'string') {
        events.push({
          id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          type: 'assistant',
          timestamp,
          content: message.content
        });
      }

      if (events.length === 0) return null;
      if (events.length === 1) return events[0];
      return events;
    }

    if (eventType === 'user') {
      // Extract content from tool_result blocks in user messages
      const message = obj.message as Record<string, unknown> | undefined;
      if (message?.content && Array.isArray(message.content)) {
        const events: ClaudeCodeEvent[] = [];
        for (const block of message.content) {
          if (typeof block === 'object' && block !== null) {
            const blockObj = block as Record<string, unknown>;
            if (blockObj.type === 'tool_result') {
              events.push({
                id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                type: 'tool_result',
                timestamp,
                toolResult: String(blockObj.content || ''),
                isError: Boolean(blockObj.is_error)
              });
            }
          }
        }
        if (events.length > 0) {
          return events.length === 1 ? events[0] : events;
        }
      }
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        type: 'user',
        timestamp,
        content: String(obj.message || obj.content || '')
      };
    }

    if (eventType === 'tool_use') {
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        type: 'tool_use',
        timestamp,
        tool: String(obj.name || obj.tool || ''),
        toolInput: (obj.input || obj.parameters || {}) as Record<string, unknown>
      };
    }

    if (eventType === 'tool_result') {
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        type: 'tool_result',
        timestamp,
        toolResult: String(obj.content || obj.output || ''),
        isError: Boolean(obj.is_error || obj.isError)
      };
    }

    if (eventType === 'result') {
      const result = obj.result as string | undefined;
      return {
        id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        type: 'result',
        timestamp,
        content: result || ''
      };
    }

    // Handle content_block events (streaming text)
    if (eventType === 'content_block_delta' || eventType === 'content_block_start') {
      const delta = obj.delta as Record<string, unknown> | undefined;
      const contentBlock = obj.content_block as Record<string, unknown> | undefined;

      let text = '';
      if (delta?.text) {
        text = String(delta.text);
      } else if (contentBlock?.text) {
        text = String(contentBlock.text);
      }

      if (text) {
        return {
          id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          type: 'assistant',
          timestamp,
          content: text
        };
      }
    }

    // Log unknown event types for debugging
    if (eventType && !['message_start', 'message_stop', 'message_delta', 'content_block_stop'].includes(eventType)) {
      console.log('Unknown Claude event type:', eventType, obj);
    }

    return null;
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

  #scheduleSave(session: ManagedClaudeCodeSession): void {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
    }
    session.saveTimer = setTimeout(() => {
      saveClaudeCodeSession(this.#toSnapshot(session));
    }, 2000); // Debounce 2 seconds
  }

  #toSnapshot(session: ManagedClaudeCodeSession): ClaudeCodeSession {
    return {
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      events: session.events,
      isActive: session.process !== null
    };
  }

  getSession(id: string): ClaudeCodeSession | null {
    const session = this.#sessions.get(id);
    return session ? this.#toSnapshot(session) : null;
  }

  getAllSessions(): ClaudeCodeSession[] {
    return Array.from(this.#sessions.values()).map(s => this.#toSnapshot(s));
  }

  subscribe(id: string, handler: (event: ClaudeCodeEvent) => void): () => void {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  sendInput(id: string, text: string): void {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    // Don't allow sending if a process is already running
    if (session.process) {
      throw new Error(`Session is busy processing a previous message`);
    }

    // Add user message to events
    const event: ClaudeCodeEvent = {
      id: `evt-${Date.now()}`,
      type: 'user',
      timestamp: Date.now(),
      content: text
    };
    session.events.push(event);
    this.#notifySubscribers(session, event);
    this.#scheduleSave(session);

    // Spawn Claude with this prompt
    this.#runClaudeWithPrompt(session, text);
  }

  restoreSession(id: string): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    // If there's no Claude session ID, create one for continued conversations
    if (!this.#claudeSessionIds.has(id)) {
      this.#claudeSessionIds.set(id, randomUUID());
    }

    return this.#toSnapshot(session);
  }

  stopSession(id: string): void {
    const session = this.#sessions.get(id);
    if (session?.process) {
      session.process.kill();
      session.process = null;
    }
  }

  deleteSession(id: string): void {
    this.stopSession(id);
    this.#sessions.delete(id);
    deleteClaudeCodeSession(id);
  }
}

