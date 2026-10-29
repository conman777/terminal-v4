import { describe, expect, it, vi } from 'vitest';
import { reopenWorkspaceSession } from './workspaceNavigation';

describe('reopenWorkspaceSession', () => {
  it('restores and unarchives a saved session before adding and selecting it in the requested pane', async () => {
    const calls = [];
    const actions = Object.fromEntries(['restoreSession', 'unarchiveSession', 'addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => [name, vi.fn((...args) => calls.push([name, ...args]))]));
    await reopenWorkspaceSession('saved', actions, 'pane');
    expect(calls).toEqual([
      ['restoreSession', 'saved', { select: false }], ['unarchiveSession', 'saved'], ['addSessionToDesktop', 'saved'],
      ['focusPane', 'pane'], ['setPaneSession', 'pane', 'saved'], ['selectSession', 'saved'],
    ]);
  });
  it('propagates restoration failures before altering the desktop or pane', async () => {
    const addSessionToDesktop = vi.fn();
    const failure = new Error('Session is unavailable');
    await expect(reopenWorkspaceSession('saved', { restoreSession: () => Promise.reject(failure), addSessionToDesktop })).rejects.toThrow('Session is unavailable');
    expect(addSessionToDesktop).not.toHaveBeenCalled();
  });
  it('stops after restoration if a later selection invalidated its shared token', async () => {
    let resolveRestore;
    const actions = Object.fromEntries(['unarchiveSession', 'addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => [name, vi.fn()]));
    actions.restoreSession = () => new Promise(resolve => { resolveRestore = resolve; });
    const pending = reopenWorkspaceSession('saved', actions, 'pane');
    resolveRestore({ restored: true, isCurrent: () => false });
    expect(await pending).toMatchObject({ reopened: false, stale: true });
    for (const action of ['unarchiveSession', 'addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane']) expect(actions[action]).not.toHaveBeenCalled();
  });
  it('rechecks its shared token after unarchive before committing desktop, pane or focus', async () => {
    let current = true, resolveUnarchive;
    const actions = Object.fromEntries(['addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => [name, vi.fn()]));
    actions.restoreSession = async () => ({ restored: true, isCurrent: () => current });
    actions.unarchiveSession = () => new Promise(resolve => { resolveUnarchive = resolve; });
    const pending = reopenWorkspaceSession('saved', actions, 'pane');
    await Promise.resolve();current = false;resolveUnarchive();
    expect(await pending).toMatchObject({ reopened: false, stale: true });
    for (const action of ['addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane']) expect(actions[action]).not.toHaveBeenCalled();
  });

  it('does not commit a history result after its pane or desktop has disappeared', async () => {
    let current = true, finish;
    const actions = Object.fromEntries(['addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => [name, vi.fn()]));
    actions.restoreSession = async () => ({ isCurrent: () => true });
    actions.unarchiveSession = () => new Promise(resolve => { finish = resolve; });
    actions.isTargetCurrent = () => current;
    const pending = reopenWorkspaceSession('saved', actions, 'pane');
    await Promise.resolve();
    current = false; finish();
    expect(await pending).toEqual({ reopened: false, stale: true });
    expect(['addSessionToDesktop', 'selectSession', 'setPaneSession', 'focusPane'].map(name => actions[name].mock.calls)).toEqual([[], [], [], []]);
  });

});
