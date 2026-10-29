import { describe, expect, it } from 'vitest';
import { describeAddToChat, resolveTerminalOwner } from './addToChatState';

const sessions = [
  { id: 'ss-a', title: 'Alpha', thread: { topic: 'Alpha topic' } },
  { id: 'ss-b', title: 'Bravo' },
  { id: 'pty-1', title: 'Shell', thread: { companionOf: 'ss-a' } },
  { id: 'pty-2', title: 'Loose shell' },
  { id: 'pty-3', title: 'Orphan', thread: { companionOf: 'ss-gone' } },
];

describe('resolveTerminalOwner', () => {
  it('uses a thread as its own terminal owner', () => {
    expect(resolveTerminalOwner({ terminalId: 'ss-b', sessions })).toEqual({ threadId: 'ss-b', title: 'Bravo' });
  });

  it('uses the thread that owns a companion terminal', () => {
    expect(resolveTerminalOwner({ terminalId: 'pty-1', sessions, activeThreadId: 'ss-b' })).toEqual({ threadId: 'ss-a', title: 'Alpha topic' });
  });

  it('falls back to the active structured thread for a standalone terminal', () => {
    expect(resolveTerminalOwner({ terminalId: 'pty-2', sessions, activeThreadId: 'ss-b' })).toEqual({ threadId: 'ss-b', title: 'Bravo' });
  });

  it.each([
    ['no active thread', { terminalId: 'pty-2', sessions }],
    ['an active session that is not a thread', { terminalId: 'pty-2', sessions, activeThreadId: 'pty-1' }],
    ['an active thread that is not listed', { terminalId: 'pty-2', sessions, activeThreadId: 'ss-gone' }],
    ['an owner that is not listed', { terminalId: 'pty-3', sessions }],
    ['no sessions', { terminalId: 'pty-2' }],
  ])('has no owner with %s', (_name, input) => {
    expect(resolveTerminalOwner(input)).toBeNull();
  });
});

describe('describeAddToChat', () => {
  const owner = { threadId: 'ss-a', title: 'Alpha' };

  it('is hidden without a selection', () => {
    expect(describeAddToChat({ owner, text: '' })).toEqual({ visible: false, disabled: true, reason: '' });
  });

  it('is enabled for text with a thread', () => {
    expect(describeAddToChat({ owner, text: 'npm test' })).toEqual({ visible: true, disabled: false, reason: '' });
  });

  it('explains a whitespace-only selection', () => {
    expect(describeAddToChat({ owner, text: ' \n\t ' })).toEqual({ visible: true, disabled: true, reason: 'The selection is blank.' });
  });

  it('explains a missing thread before anything else', () => {
    expect(describeAddToChat({ owner: null, text: 'npm test' })).toEqual({ visible: true, disabled: true, reason: 'Open this terminal from a thread to add its output to that thread’s chat.' });
  });
});
