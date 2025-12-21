import { describe, expect, it, vi } from 'vitest';

const TEST_USER_ID = 'test-user-123';

type DataHandler = (data: string) => void;
type ExitHandler = (e: { exitCode: number; signal?: number }) => void;

class FakePty {
  #dataHandlers: DataHandler[] = [];
  #exitHandlers: ExitHandler[] = [];
  #killed = false;

  onData(handler: DataHandler) {
    this.#dataHandlers.push(handler);
  }

  onExit(handler: ExitHandler) {
    this.#exitHandlers.push(handler);
  }

  emitData(data: string) {
    if (this.#killed) return;
    for (const handler of this.#dataHandlers) handler(data);
  }

  emitExit(exitCode = 0) {
    for (const handler of this.#exitHandlers) handler({ exitCode });
  }

  kill(_signal?: string) {
    this.#killed = true;
    this.emitExit(0);
  }

  get killed() {
    return this.#killed;
  }
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: spawnMock
}));

import { ClaudeCodeManager } from '../src/claude-code/claude-code-manager';

describe('ClaudeCodeManager', () => {
  it('does not drop stream-json messages when multiple lines arrive in a single data chunk', async () => {
    spawnMock.mockReset();
    const fakePty = new FakePty();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        const msg1 = {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] }
        };
        const msg2 = {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'world' }] }
        };

        fakePty.emitData(`${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`);
        fakePty.emitExit(0);
      });
      return fakePty as any;
    });

    const manager = new ClaudeCodeManager();
    const session = manager.createSession(TEST_USER_ID, process.cwd());
    await manager.sendInput(TEST_USER_ID, session.id, 'test');

    const updated = manager.getSession(TEST_USER_ID, session.id);
    expect(updated).not.toBeNull();

    const assistantTexts = (updated?.events || [])
      .filter((e) => e.type === 'assistant')
      .map((e) => e.content);

    expect(assistantTexts).toEqual(expect.arrayContaining(['hello', 'world']));
  });

  it('emits a system error event (isError=true) when the CLI cannot be spawned', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const manager = new ClaudeCodeManager();
    const session = manager.createSession(TEST_USER_ID, process.cwd());

    await expect(manager.sendInput(TEST_USER_ID, session.id, 'test')).rejects.toThrow('spawn failed');

    const updated = manager.getSession(TEST_USER_ID, session.id);
    const lastEvent = updated?.events.at(-1);
    expect(lastEvent?.type).toBe('system');
    expect(lastEvent?.isError).toBe(true);
    expect(lastEvent?.content).toContain('spawn failed');
  });
});
