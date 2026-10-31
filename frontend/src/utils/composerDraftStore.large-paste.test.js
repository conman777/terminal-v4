import { describe, expect, it } from 'vitest';
import { getComposerDraftStore } from './composerDraftStore';

describe('finalizing a saved oversized paste', () => {
  it('replaces the unsaved local paste only when its original saved draft is unchanged', () => {
    const store = getComposerDraftStore('large-paste-finalize');
    store.setText('before SELECT after');
    const base = store.getSnapshot();
    const large = 'before ' + 'x'.repeat(1_000_000) + ' after';
    store.setText(large);
    const pending = store.getSnapshot();
    expect(pending.error).toMatch(/could not be saved/i);
    expect(store.finalizeLargePaste({ baseText: base.text, baseRevision: base.revision, localText: large, localRevision: pending.revision, remaining: 'before  after' })).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ text: 'before  after', error: '' });
  });

  it('does not overwrite a newer persisted draft or drop the unsaved local paste', () => {
    const store = getComposerDraftStore('large-paste-other-tab');
    store.setText('original');
    const base = store.getSnapshot();
    const large = 'x'.repeat(1_000_000);
    store.setText(large);
    const pending = store.getSnapshot();
    const key = Object.keys(localStorage).find(value => value.includes('composerDraft:v1:') && value.includes('large-paste-other-tab'));
    const saved = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...saved, text: 'newer tab text', revision: '44444444-4444-4444-8444-444444444444' }));
    expect(store.finalizeLargePaste({ baseText: base.text, baseRevision: base.revision, localText: large, localRevision: pending.revision, remaining: '' })).toBe(false);
    expect(store.getSnapshot().text).toBe(large);
    expect(JSON.parse(localStorage.getItem(key)).text).toBe('newer tab text');
  });

  it('records an empty base before finalization and rejects newer local edits', () => {
    const store = getComposerDraftStore('large-paste-empty-base');
    const base = store.getSnapshot();
    expect(store.ensureSavedForPaste(base.text, base.revision)).toBe(true);
    const large = 'x'.repeat(1_000_000);
    store.setText(large);
    const pending = store.getSnapshot();
    store.setText(`${large}newer`);
    expect(store.finalizeLargePaste({ baseText: '', baseRevision: base.revision, localText: large, localRevision: pending.revision, remaining: '' })).toBe(false);
    expect(store.getSnapshot().text).toBe(`${large}newer`);
  });

  it('finalizes a paste held outside the draft only while the original draft is unchanged', () => {
    const store = getComposerDraftStore('large-paste-outside-draft');
    store.setText('before SELECT after');
    const base = store.getSnapshot();
    expect(store.ensureSavedForPaste(base.text, base.revision)).toBe(true);
    expect(store.finalizeSavedPaste({ baseText: base.text, baseRevision: base.revision, remaining: 'before  after' })).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ text: 'before  after', error: '' });
    expect(store.finalizeSavedPaste({ baseText: base.text, baseRevision: base.revision, remaining: 'wrong' })).toBe(false);
  });
});
