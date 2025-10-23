import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { registerCoreRoutes } from '../src/routes/register-core-routes';
import { MemorySessionStore } from '../src/session/memory-session-store';
import type { SessionStore } from '../src/session/types';
import type { TerminalManager } from '../src/terminal/terminal-manager';

class FakeClaudeProcess extends EventEmitter implements ChildProcessWithoutNullStreams {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;
  connected = true;
  spawnargs: string[] = [];
  spawnfile = 'claude';
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

class FakeRawResponse extends EventEmitter {
  status?: number;
  headers?: Record<string, string>;
  chunks: string[] = [];
  ended = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string) {
    this.chunks.push(chunk);
  }

  end() {
    this.ended = true;
    this.emit('finish');
  }

  flushHeaders() {
    // no-op
  }
}

class FakeReply {
  raw = new FakeRawResponse();
  statusCode = 200;
  payload: unknown = null;
  hijacked = false;

  code(status: number) {
    this.statusCode = status;
    return this;
  }

  headers() {
    return this;
  }

  send(payload: unknown) {
    this.payload = payload;
    return this;
  }

  hijack() {
    this.hijacked = true;
  }
}

function createRouteCollector() {
  const routes = new Map<string, (req: any, reply: any) => Promise<void> | void>();
  const appStub = {
    get(path: string, handler: (req: any, reply: any) => void) {
      routes.set(`GET ${path}`, handler);
      return appStub;
    },
    post(path: string, handler: (req: any, reply: any) => void) {
      routes.set(`POST ${path}`, handler);
      return appStub;
    }
  } as unknown as FastifyInstance;

  return { appStub, routes };
}

describe('Chat streaming handler', () => {
  it('streams Claude output as SSE and updates session store', async () => {
    const sessionStore: SessionStore = new MemorySessionStore();
    const fakeProcess = new FakeClaudeProcess();
    const spawnMock = vi.fn().mockReturnValue(fakeProcess as unknown as ChildProcessWithoutNullStreams);

    const { appStub, routes } = createRouteCollector();
    const terminalManagerStub: Partial<TerminalManager> = {
      listSessions: () => [],
      createSession: vi.fn(),
      getSession: () => null,
      write: vi.fn(),
      subscribe: vi.fn(() => () => {})
    };
    await registerCoreRoutes(appStub, {
      sessionStore,
      spawnClaude: spawnMock,
      terminalManager: terminalManagerStub as TerminalManager
    });
    const chatHandler = routes.get('POST /api/chat');
    expect(chatHandler).toBeDefined();

    const request = {
      body: { message: 'List files' },
      raw: new EventEmitter()
    };
    const reply = new FakeReply();

    await chatHandler?.(request, reply);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'List files' })
    );
    expect(reply.hijacked).toBe(true);
    expect(reply.raw.status).toBe(200);
    expect(reply.raw.headers?.['Content-Type']).toBe('text/event-stream');

    fakeProcess.stdout.push('{"text":"Here you go"}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reply.raw.chunks.join('')).toContain('event: chunk');

    fakeProcess.stdout.push(null);
    fakeProcess.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reply.raw.ended).toBe(true);

    const sessions = sessionStore.listSessions();
    expect(sessions).toHaveLength(1);

    const stored = sessionStore.getSession(sessions[0].id);
    expect(stored?.messages.at(-1)?.content).toContain('Here you go');
  });
});
