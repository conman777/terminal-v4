import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Agent, type AgentResponseMessage } from '@anthropic-ai/claude-agent-sdk';
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
  #apiKey: string;

  constructor(apiKey?: string) {
    this.#apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!this.#apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required');
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;

    // Load persisted sessions on startup
    const persisted = await loadAllClaudeCodeSessions();
    for (const session of persisted) {
      // Create a new agent for each persisted session
      const agent = new Agent({
        apiKey: this.#apiKey,
        cwd: session.cwd,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
        systemPrompt: 'You are a helpful coding assistant working in a terminal environment.'
      });

      this.#sessions.set(session.id, {
        id: session.id,
        cwd: session.cwd,
        agent,
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

    // Resolve to absolute path for persistence
    const absoluteCwd = resolve(cwd);

    // Create Agent instance
    const agent = new Agent({
      apiKey: this.#apiKey,
      cwd: absoluteCwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      systemPrompt: 'You are a helpful coding assistant working in a terminal environment.',
      // Auto-accept edits to avoid permission prompts
      permissionMode: 'acceptEdits'
    });

    const session: ManagedClaudeCodeSession = {
      id,
      cwd: absoluteCwd,
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

  // Map SDK events to our event format
  #mapSDKEvent(message: AgentResponseMessage): ClaudeCodeEvent | null {
    const timestamp = Date.now();
    const id = `evt-${timestamp}-${Math.random().toString(36).substr(2, 5)}`;

    // Handle different message types from the SDK
    if (message.type === 'text') {
      return {
        id,
        type: 'assistant',
        timestamp,
        content: message.content
      };
    }

    if (message.type === 'tool_use') {
      return {
        id,
        type: 'tool_use',
        timestamp,
        tool: message.name,
        toolInput: message.input as Record<string, unknown>
      };
    }

    if (message.type === 'tool_result') {
      return {
        id,
        type: 'tool_result',
        timestamp,
        toolResult: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        isError: message.isError || false
      };
    }

    // Unknown or unsupported message type
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
      isActive: false // SDK doesn't have a concept of "active" in the same way
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

  async sendInput(id: string, text: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

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
      // Query the agent and stream responses
      for await (const message of session.agent.query(text)) {
        const event = this.#mapSDKEvent(message);
        if (event) {
          console.log('[CLAUDE SDK]', event.type, event.id);
          session.events.push(event);
          this.#notifySubscribers(session, event);
          this.#scheduleSave(session);
        }
      }
    } catch (error) {
      console.error('[CLAUDE SDK ERROR]', error);
      // Add error event
      const errorEvent: ClaudeCodeEvent = {
        id: `evt-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: `Error: ${error instanceof Error ? error.message : String(error)}`
      };
      session.events.push(errorEvent);
      this.#notifySubscribers(session, errorEvent);
      this.#scheduleSave(session);
      throw error;
    }
  }

  restoreSession(id: string): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    return this.#toSnapshot(session);
  }

  stopSession(id: string): void {
    // SDK doesn't have a concept of "stopping" - sessions are stateless
    // This is kept for API compatibility but is a no-op
    const session = this.#sessions.get(id);
    if (session) {
      console.log('[CLAUDE SDK] Stop requested for session', id);
    }
  }

  deleteSession(id: string): void {
    this.stopSession(id);
    this.#sessions.delete(id);
    deleteClaudeCodeSession(id);
  }

  updateCwd(id: string, cwd: string): ClaudeCodeSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    // Resolve to absolute path
    const absoluteCwd = resolve(cwd);
    session.cwd = absoluteCwd;

    // Create a new agent with the updated cwd
    session.agent = new Agent({
      apiKey: this.#apiKey,
      cwd: absoluteCwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      systemPrompt: 'You are a helpful coding assistant working in a terminal environment.',
      permissionMode: 'acceptEdits'
    });

    this.#scheduleSave(session);

    return this.#toSnapshot(session);
  }
}
