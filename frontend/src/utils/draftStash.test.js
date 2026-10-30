import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { loadStash, stashDraft, takeStashed } from './draftStash';

beforeEach(() => {
  localStorage.clear();
  setEnvironmentIdentity('account-a');
});
afterEach(() => {
  vi.restoreAllMocks();
  setActiveEnvironment(null);
  setEnvironmentIdentity('');
});

describe('draft stash', () => {
  it('keeps the newest drafts first and hands one back when restored', () => {
    stashDraft('First idea', 1);
    stashDraft('  ', 2);
    stashDraft('Second idea', 3);
    const listed = loadStash().map(item => item.text);
    const restored = takeStashed(loadStash()[1].id);
    expect([listed, restored, loadStash().map(item => item.text)]).toEqual([['Second idea', 'First idea'], 'First idea', ['Second idea']]);
  });

  it('does not show one account its stash after another account signs in', () => {
    stashDraft('private to A', 1);
    setEnvironmentIdentity('account-b');
    const asB = loadStash().map(item => item.text);
    setEnvironmentIdentity('account-a');
    expect([asB, loadStash().map(item => item.text)]).toEqual([[], ['private to A']]);
  });

  it('keeps each environment of the same account separate', () => {
    stashDraft('home draft', 1);
    setActiveEnvironment({ id: 'laptop' });
    const onLaptop = loadStash().map(item => item.text);
    stashDraft('laptop draft', 2);
    setActiveEnvironment(null);
    expect([onLaptop, loadStash().map(item => item.text)]).toEqual([[], ['home draft']]);
  });

  it('never adopts an old unscoped stash as the signed-in account\'s drafts', () => {
    localStorage.setItem('tv4StashedDrafts', JSON.stringify([{ id: 'old', text: 'left behind by someone else', at: 1 }]));
    expect(loadStash()).toEqual([]);
  });

  it('refuses to store or list anything while nobody is signed in', () => {
    setEnvironmentIdentity('');
    expect([stashDraft('orphan', 1).ok, loadStash()]).toEqual([false, []]);
    expect(Object.keys(localStorage).filter(key => key.toLowerCase().includes('stash'))).toEqual([]);
  });

  it('reports a failed save instead of pretending the draft was stashed', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const result = stashDraft('must not be lost', 1);
    expect([result.ok, result.items]).toEqual([false, []]);
  });

  it('reports success with the saved list when storage works', () => {
    const result = stashDraft('kept', 1);
    expect([result.ok, result.items.map(item => item.text)]).toEqual([true, ['kept']]);
  });
});
