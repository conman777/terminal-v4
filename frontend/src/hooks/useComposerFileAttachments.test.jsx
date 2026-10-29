import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { useComposerFileAttachments } from './useComposerFileAttachments';

beforeEach(() => {
  localStorage.clear();
  setUser({ id: 'fixture-owner' });
  setEnvironmentIdentity('fixture-owner', window.location.origin);
  setActiveEnvironment(null);
});
afterEach(() => { vi.restoreAllMocks(); clearTokens(true); setEnvironmentIdentity(null); localStorage.clear(); });

it('restores only the selected paths for the same account, environment and conversation', () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-restore'));
  act(() => first.result.current[1]([{ name: 'notes.txt', path: '/fixture/notes.txt' }]));
  first.unmount();
  setUser({ id: 'other-owner' });
  setEnvironmentIdentity('other-owner', window.location.origin);
  const other = renderHook(() => useComposerFileAttachments('ss-file-restore'));
  expect(other.result.current[0]).toEqual([]);
  other.unmount();
  setUser({ id: 'fixture-owner' });
  setEnvironmentIdentity('fixture-owner', window.location.origin);
  const restored = renderHook(() => useComposerFileAttachments('ss-file-restore'));
  expect(restored.result.current[0]).toEqual([{ name: 'notes.txt', path: '/fixture/notes.txt' }]);
  const anotherThread = renderHook(() => useComposerFileAttachments('ss-another-file-restore'));
  expect(anotherThread.result.current[0]).toEqual([]);
  setActiveEnvironment({ id: 'other-host' });
  const anotherEnvironment = renderHook(() => useComposerFileAttachments('ss-file-restore'));
  expect(anotherEnvironment.result.current[0]).toEqual([]);
});

it('keeps the restored-file warning while an original restored selection remains', () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-restored-warning'));
  act(() => first.result.current[1]([{ name: 'restored.txt', path: '/fixture/restored.txt' }]));
  first.unmount();
  setEnvironmentIdentity('other-owner', window.location.origin);
  setEnvironmentIdentity('fixture-owner', window.location.origin);
  const restored = renderHook(() => useComposerFileAttachments('ss-file-restored-warning'));
  expect(restored.result.current[4]).toBe(true);
  act(() => restored.result.current[1](items => [...items, { name: 'new.txt', path: '/fixture/new.txt' }]));
  expect(restored.result.current[4]).toBe(true);
  act(() => restored.result.current[1](items => items.filter(item => item.path !== '/fixture/restored.txt')));
  expect(restored.result.current[4]).toBe(false);
  expect(restored.result.current[0]).toEqual([{ name: 'new.txt', path: '/fixture/new.txt' }]);
});

it('retains a selection and reports a failed save until storage recovers', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-quota'));
  const original = Storage.prototype.setItem;
  const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key.includes('composerFiles:')) throw new Error('storage full');
    return original.call(this, key, value);
  });
  act(() => store.result.current[1]([{ name: 'quota.txt', path: '/fixture/quota.txt', bytes: 'must not persist' }]));
  expect(store.result.current[0]).toEqual([{ name: 'quota.txt', path: '/fixture/quota.txt', bytes: 'must not persist' }]);
  expect(store.result.current[2]).toMatch(/could not be saved/);
  mock.mockRestore();
  act(() => store.result.current[3]());
  expect(store.result.current[2]).toBe('');
  const saved = Object.entries(localStorage).find(([key]) => key.includes('composerFiles:'));
  expect(JSON.parse(saved[1]).items).toEqual([{ name: 'quota.txt', path: '/fixture/quota.txt' }]);
});

it('recovers an unavailable storage read when no saved selection exists', () => {
  const original = Storage.prototype.getItem;
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
    if (key.includes('composerFiles:')) throw new Error('storage unavailable');
    return original.call(this, key);
  });
  const store = renderHook(() => useComposerFileAttachments('ss-file-read-error'));
  expect(store.result.current[2]).toMatch(/could not be read/);
  getItem.mockRestore();
  act(() => store.result.current[3]());
  expect(store.result.current[2]).toBe('');
});

it('does not overwrite a different selection saved by another tab', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-conflict'));
  act(() => store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-conflict', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] });
  localStorage.setItem(key, other);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: other, storageArea: localStorage })));
  expect(store.result.current[2]).toMatch(/another tab/);
  act(() => store.result.current[1](items => [...items, { name: 'later.txt', path: '/fixture/later.txt' }]));
  expect(localStorage.getItem(key)).toBe(other);
  expect(store.result.current[0].map(item => item.name)).toEqual(['first.txt', 'later.txt']);
  expect(store.result.current[2]).toMatch(/changed in another tab/);
});

it('reports a cross-tab change made while the conversation is not mounted', () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-unmounted-conflict'));
  act(() => first.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  first.unmount();
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-unmounted-conflict', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] });
  localStorage.setItem(key, other);

  const reopened = renderHook(() => useComposerFileAttachments('ss-file-unmounted-conflict'));
  expect(reopened.result.current[0]).toEqual([{ name: 'first.txt', path: '/fixture/first.txt' }]);
  expect(reopened.result.current[2]).toMatch(/another tab/);
  expect(localStorage.getItem(key)).toBe(other);
});

it('lets the user review and adopt the other tab’s saved selections without writing to storage', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-adopt'));
  act(() => store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-adopt', items: [{ name: 'theirs.txt', path: '/fixture/theirs.txt', bytes: 'not persisted by this tab' }] });
  localStorage.setItem(key, other);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: other, storageArea: localStorage })));
  const reviewed = store.result.current[5];
  const previousSelection = store.result.current[8]();
  expect(reviewed.items).toEqual([{ name: 'theirs.txt', path: '/fixture/theirs.txt' }]);
  expect(store.result.current[0]).toEqual([{ name: 'mine.txt', path: '/fixture/mine.txt' }]);
  act(() => { expect(store.result.current[6](reviewed)).toBe(true); });
  expect(store.result.current[0]).toEqual([{ name: 'theirs.txt', path: '/fixture/theirs.txt' }]);
  expect(store.result.current[2]).toBe('');
  expect(store.result.current[4]).toBe(true);
  expect(store.result.current[9](previousSelection)).toBe(false);
  expect(store.result.current[9](store.result.current[8]())).toBe(true);
  expect(localStorage.getItem(key)).toBe(other);
});

it('keeps the local selection if saved files change after the user reviews them', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-stale-review'));
  act(() => store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  const saved = name => JSON.stringify({ version: 1, sessionId: 'ss-file-stale-review', items: [{ name, path: `/fixture/${name}` }] });
  localStorage.setItem(key, saved('one.txt'));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: saved('one.txt'), storageArea: localStorage })));
  const reviewed = store.result.current[5];
  localStorage.setItem(key, saved('two.txt'));
  act(() => { expect(store.result.current[6](reviewed)).toBe(false); });
  expect(store.result.current[0]).toEqual([{ name: 'mine.txt', path: '/fixture/mine.txt' }]);
  expect(store.result.current[5].items).toEqual([{ name: 'two.txt', path: '/fixture/two.txt' }]);
  expect(localStorage.getItem(key)).toBe(saved('two.txt'));
});

it('invalidates an old upload token in every pane sharing the conversation', () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-shared-adoption'));
  const second = renderHook(() => useComposerFileAttachments('ss-file-shared-adoption'));
  act(() => first.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]));
  const token = first.result.current[8]();
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes('ss-file-shared-adoption'));
  const saved = JSON.stringify({ version: 1, sessionId: 'ss-file-shared-adoption', items: [{ name: 'saved.txt', path: '/fixture/saved.txt' }] });
  localStorage.setItem(key, saved);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: saved, storageArea: localStorage })));
  act(() => { expect(second.result.current[6](second.result.current[5])).toBe(true); });
  expect(first.result.current[9](token)).toBe(false);
  expect(first.result.current[0]).toEqual([{ name: 'saved.txt', path: '/fixture/saved.txt' }]);
  expect(second.result.current[0]).toEqual([{ name: 'saved.txt', path: '/fixture/saved.txt' }]);
});

it('does not offer adoption for invalid saved files or after the account changes', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-invalid-review'));
  act(() => store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  localStorage.setItem(key, '{invalid');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{invalid', storageArea: localStorage })));
  expect(store.result.current[5]).toBeNull();
  expect(store.result.current[0]).toEqual([{ name: 'mine.txt', path: '/fixture/mine.txt' }]);
  expect(store.result.current[2]).toMatch(/could not be read/i);
  const stale = store.result.current[6];
  act(() => { setUser({ id: 'other-owner' }); setEnvironmentIdentity('other-owner', window.location.origin); });
  expect(stale({ items: [] })).toBe(false);
  expect(localStorage.getItem(key)).toBe('{invalid');
});

it('detects a saved change synchronously before send even if the storage event is delayed', () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-pre-send'));
  act(() => store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]));
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: 'ss-file-pre-send', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] }));
  expect(store.result.current[2]).toBe('');
  act(() => { expect(store.result.current[7]()).toBe(false); });
  expect(store.result.current[0]).toEqual([{ name: 'mine.txt', path: '/fixture/mine.txt' }]);
  expect(store.result.current[2]).toMatch(/another tab/);
});
