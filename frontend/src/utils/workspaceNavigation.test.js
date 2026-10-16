import { describe, expect, it, vi } from 'vitest';
import { reopenWorkspaceSession } from './workspaceNavigation';

describe('reopenWorkspaceSession', () => {
  it('restores and unarchives a saved session before adding and selecting it in the requested pane', async () => {
    const calls = [];
    const actions = Object.fromEntries(['restoreSession', 'unarchiveSession', 'addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => [name, vi.fn((...args) => calls.push([name, ...args]))]));
    await reopenWorkspaceSession('saved', actions, 'pane');
    expect(calls).toEqual([
      ['restoreSession', 'saved'], ['unarchiveSession', 'saved'], ['addSessionToDesktop', 'saved'],
      ['focusPane', 'pane'], ['setPaneSession', 'pane', 'saved'], ['selectSession', 'saved'],
    ]);
  });
  it('propagates restoration failures before altering the desktop or pane', async () => {
    const addSessionToDesktop = vi.fn();
    const failure = new Error('Session is unavailable');
    await expect(reopenWorkspaceSession('saved', { restoreSession: () => Promise.reject(failure), addSessionToDesktop })).rejects.toThrow('Session is unavailable');
    expect(addSessionToDesktop).not.toHaveBeenCalled();
  });
});
