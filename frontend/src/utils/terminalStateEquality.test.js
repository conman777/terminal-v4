import { describe, expect, it } from 'vitest';
import { areEquivalentTerminalStates } from './terminalStateEquality';

describe('areEquivalentTerminalStates', () => {
  it('treats structurally identical session arrays as equal', () => {
    const previousValue = [
      { id: 'session-1', title: 'Thread A', thread: { topic: 'Thread A', archived: false } }
    ];
    const nextValue = [
      { id: 'session-1', title: 'Thread A', thread: { archived: false, topic: 'Thread A' } }
    ];

    expect(areEquivalentTerminalStates(previousValue, nextValue)).toBe(true);
  });

  it('detects when a session field changed', () => {
    const previousValue = [
      { id: 'session-1', title: 'Thread A', isBusy: false }
    ];
    const nextValue = [
      { id: 'session-1', title: 'Thread A', isBusy: true }
    ];

    expect(areEquivalentTerminalStates(previousValue, nextValue)).toBe(false);
  });

  it('treats equivalent project info objects as equal', () => {
    const previousValue = { cwd: 'C:\\repo', branch: 'main' };
    const nextValue = { branch: 'main', cwd: 'C:\\repo' };

    expect(areEquivalentTerminalStates(previousValue, nextValue)).toBe(true);
  });
});
