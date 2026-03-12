import { describe, expect, it } from 'vitest';

/**
 * Reducer-model tests for the tool-call correlation logic in useStructuredSession.
 *
 * These tests validate the toolCallId-based matching contract that processEvent
 * implements inside the hook. They exercise a local replica of the state machine
 * rather than the hook itself, because the real hook requires a WebSocket
 * connection to drive events. If the switch/case logic in useStructuredSession.js
 * is refactored into a standalone reducer, these tests should be updated to
 * import and test that reducer directly.
 *
 * This is NOT hook-level coverage. A full integration test would need a mock
 * WebSocket server feeding structured_event frames.
 */

function processToolEvents(events) {
  let toolCalls = [];
  let messages = [];

  for (const event of events) {
    switch (event.type) {
      case 'tool_started':
        toolCalls = [
          ...toolCalls,
          {
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolCallId: event.toolCallId,
            status: 'running',
            result: null,
          },
        ];
        break;

      case 'tool_output':
        toolCalls = toolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId && tc.status === 'running'
            ? { ...tc, result: (tc.result || '') + event.output }
            : tc
        );
        break;

      case 'tool_completed': {
        const updated = toolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId && tc.status === 'running'
            ? { ...tc, status: 'completed', result: event.result, isError: event.isError }
            : tc
        );
        const completed = updated.filter((tc) => tc.status === 'completed');
        const remaining = updated.filter((tc) => tc.status !== 'completed');

        messages = [
          ...messages,
          ...completed.map((tc) => ({
            role: 'tool',
            toolName: tc.toolName,
            result: tc.result,
            isError: tc.isError,
          })),
        ];
        toolCalls = remaining;
        break;
      }

      default:
        break;
    }
  }

  return { toolCalls, messages };
}

describe('tool-call correlation (reducer-model, mirrors useStructuredSession processEvent)', () => {
  it('routes output to the correct tool when two calls of the same tool run concurrently', () => {
    const events = [
      { type: 'tool_started', toolName: 'Read', toolCallId: 'call-1', toolInput: { path: '/a.js' } },
      { type: 'tool_started', toolName: 'Read', toolCallId: 'call-2', toolInput: { path: '/b.js' } },
      { type: 'tool_output', toolName: 'Read', toolCallId: 'call-1', output: 'content-A' },
      { type: 'tool_output', toolName: 'Read', toolCallId: 'call-2', output: 'content-B' },
      { type: 'tool_completed', toolName: 'Read', toolCallId: 'call-1', result: 'content-A', isError: false, ts: 1 },
      { type: 'tool_completed', toolName: 'Read', toolCallId: 'call-2', result: 'content-B', isError: false, ts: 2 },
    ];

    const { toolCalls, messages } = processToolEvents(events);

    expect(toolCalls).toEqual([]);
    expect(messages).toEqual([
      { role: 'tool', toolName: 'Read', result: 'content-A', isError: false },
      { role: 'tool', toolName: 'Read', result: 'content-B', isError: false },
    ]);
  });

  it('does not corrupt output when completing tools out of start order', () => {
    const events = [
      { type: 'tool_started', toolName: 'Bash', toolCallId: 'c1', toolInput: { cmd: 'ls' } },
      { type: 'tool_started', toolName: 'Bash', toolCallId: 'c2', toolInput: { cmd: 'pwd' } },
      { type: 'tool_output', toolName: 'Bash', toolCallId: 'c2', output: '/home' },
      { type: 'tool_completed', toolName: 'Bash', toolCallId: 'c2', result: '/home', isError: false, ts: 1 },
      { type: 'tool_output', toolName: 'Bash', toolCallId: 'c1', output: 'file.txt' },
      { type: 'tool_completed', toolName: 'Bash', toolCallId: 'c1', result: 'file.txt', isError: false, ts: 2 },
    ];

    const { toolCalls, messages } = processToolEvents(events);

    expect(toolCalls).toEqual([]);
    expect(messages).toEqual([
      { role: 'tool', toolName: 'Bash', result: '/home', isError: false },
      { role: 'tool', toolName: 'Bash', result: 'file.txt', isError: false },
    ]);
  });

  it('ignores output for an unknown toolCallId', () => {
    const events = [
      { type: 'tool_started', toolName: 'Read', toolCallId: 'c1', toolInput: {} },
      { type: 'tool_output', toolName: 'Read', toolCallId: 'unknown', output: 'rogue' },
      { type: 'tool_completed', toolName: 'Read', toolCallId: 'c1', result: 'ok', isError: false, ts: 1 },
    ];

    const { messages } = processToolEvents(events);

    expect(messages).toEqual([
      { role: 'tool', toolName: 'Read', result: 'ok', isError: false },
    ]);
  });
});
