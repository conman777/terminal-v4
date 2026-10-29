import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busyTransitions, notifyAgent, setAgentNotificationsEnabled } from './agentNotifications';

describe('notifyAgent', () => {
  let shown;
  beforeEach(() => {
    shown = [];
    globalThis.Notification = Object.assign(function Notification(title, options) { shown.push([title, options.body]); }, { permission: 'granted' });
    localStorage.clear();
  });
  afterEach(() => { delete globalThis.Notification; vi.restoreAllMocks(); });

  it('notifies only when turned on and the window is not in front', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    notifyAgent('finished', 'Fix login');
    setAgentNotificationsEnabled(true);
    notifyAgent('finished', 'Fix login');
    notifyAgent('approval', 'Fix login');
    document.hasFocus.mockReturnValue(true);
    notifyAgent('finished', 'Fix login');
    expect(shown).toEqual([['Fix login', 'Finished and ready for you.'], ['Fix login', 'Needs your approval or an answer.']]);
  });
});

describe('busyTransitions', () => {
  it('reports sessions that stop after working for a while', () => {
    const since = {};
    const first = busyTransitions({ a: { isBusy: true }, b: { isBusy: true } }, {}, since, 1000);
    const second = busyTransitions({ a: { isBusy: false }, b: { isBusy: false } }, { a: { isBusy: true }, b: { isBusy: true } }, { a: 1000, b: 5500 }, 7000);
    expect([first, second]).toEqual([[], ['a']]);
  });
});
