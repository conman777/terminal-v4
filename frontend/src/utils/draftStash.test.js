import { beforeEach, describe, expect, it } from 'vitest';
import { loadStash, stashDraft, takeStashed } from './draftStash';

beforeEach(() => localStorage.clear());

describe('draft stash', () => {
  it('keeps the newest drafts first and hands one back when restored', () => {
    stashDraft('First idea', 1);
    stashDraft('  ', 2);
    stashDraft('Second idea', 3);
    const listed = loadStash().map(item => item.text);
    const restored = takeStashed(loadStash()[1].id);
    expect([listed, restored, loadStash().map(item => item.text)]).toEqual([['Second idea', 'First idea'], 'First idea', ['Second idea']]);
  });
});
