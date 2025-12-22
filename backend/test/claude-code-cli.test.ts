import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, mapClaudeCliLineToEvents } from '../src/claude/cli';
import type { ClaudeCodeEvent } from '../src/claude-code/claude-code-types';

function expectEventBase(event: ClaudeCodeEvent) {
  expect(event).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      timestamp: expect.any(Number),
      type: expect.any(String)
    })
  );
}

describe('claude cli adapter', () => {
  it('builds args for stream-json print mode with resume + dangerously-skip-permissions', () => {
    const args = buildClaudeArgs({
      message: 'Hello',
      resumeSessionId: 'abc123',
      assumeYes: true
    });

    // Order matters for `-p <message>`
    expect(args.slice(0, 2)).toEqual(['-p', 'Hello']);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--resume');
    expect(args).toContain('abc123');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('maps system init into a system event and captures session id', () => {
    const { events, sessionId } = mapClaudeCliLineToEvents({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-sonnet-4-5-20250929'
    });

    expect(sessionId).toBe('sess-1');
    expect(events).toHaveLength(1);
    expectEventBase(events[0]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('Session initialized')
      })
    );
  });

  it('maps assistant text message into an assistant event', () => {
    const { events } = mapClaudeCliLineToEvents({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [{ type: 'text', text: 'Hello world' }]
      }
    });

    expect(events).toHaveLength(1);
    expectEventBase(events[0]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'assistant',
        content: 'Hello world'
      })
    );
  });

  it('maps assistant tool_use into a tool_use event', () => {
    const { events } = mapClaudeCliLineToEvents({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls -la', description: 'List files' }
          }
        ]
      }
    });

    expect(events).toHaveLength(1);
    expectEventBase(events[0]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'tool_use',
        tool: 'Bash',
        toolInput: { command: 'ls -la', description: 'List files' }
      })
    );
  });

  it('maps user tool_result into a tool_result event', () => {
    const { events } = mapClaudeCliLineToEvents({
      type: 'user',
      session_id: 'sess-1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'ok\n',
            is_error: false
          }
        ]
      }
    });

    expect(events).toHaveLength(1);
    expectEventBase(events[0]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolResult: 'ok\n',
        isError: false
      })
    );
  });
});


