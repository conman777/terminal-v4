import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { useComposerFileAttachments } from './useComposerFileAttachments';
import { withAttachmentWriteLock } from '../utils/attachmentWriteLock';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  withAttachmentWriteLock.mockReset().mockImplementation(async action => action());
  setUser({ id: 'fixture-owner' });
  setEnvironmentIdentity('fixture-owner', window.location.origin);
  setActiveEnvironment(null);
});
afterEach(() => { vi.restoreAllMocks(); clearTokens(true); setEnvironmentIdentity(null); localStorage.clear(); sessionStorage.clear(); });

it('blocks sending while a save is waiting and applies rapid changes in order', async () => {
  let release;
  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  const store = renderHook(() => useComposerFileAttachments('ss-file-pending-writes'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  expect(store.result.current[10]).toBe(true);
  expect(store.result.current[7]()).toBe(false);
  act(() => store.result.current[1](items => [...items, { name: 'second.txt', path: '/fixture/second.txt' }]));
  expect(store.result.current[0].map(item => item.name)).toEqual(['first.txt', 'second.txt']);
  await act(async () => release());
  expect(store.result.current[10]).toBe(false);
  expect(store.result.current[7]()).toBe(true);
  const key = Object.keys(localStorage).find(value => value.includes('ss-file-pending-writes'));
  expect(JSON.parse(localStorage.getItem(key)).items.map(item => item.name)).toEqual(['first.txt', 'second.txt']);
});

it('does not confirm file-selection persistence until queued writes settle', async () => {
  let release, settled = false;
  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  const store = renderHook(() => useComposerFileAttachments('ss-file-flush'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  const result = store.result.current[12]().then(value => { settled = true; return value; });
  await act(async () => {});
  expect(settled).toBe(false);
  await act(async () => release());
  expect(await result).toBe(true);
});

it('does not confirm file-selection persistence when the queued write fails', async () => {
  withAttachmentWriteLock.mockRejectedValueOnce(new Error('synthetic storage failure'));
  const store = renderHook(() => useComposerFileAttachments('ss-file-flush-failure'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  expect(await store.result.current[12]()).toBe(false);
});

it('does not start a send when another tab changes the selection while the send waits for the lock', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-send-locked'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  let release;
  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  const send = vi.fn();
  let admission;
  act(() => { admission = store.result.current[11](store.result.current[0], () => true, send); });
  await act(async () => {});
  const key = Object.keys(localStorage).find(value => value.includes('ss-file-send-locked'));
  localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: 'ss-file-send-locked', items: [{ name: 'theirs.txt', path: '/fixture/theirs.txt' }] }));
  let result;
  await act(async () => { release(); result = await admission; });
  expect(result.started).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(store.result.current[0].map(item => item.name)).toEqual(['mine.txt']);
  expect(store.result.current[2]).toMatch(/another tab/);
});

it('does not start a send when its view or local selection changes while waiting', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-send-view-change'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  let release;
  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  const send = vi.fn();
  let allowed = true, admission;
  act(() => { admission = store.result.current[11](store.result.current[0], () => allowed, send); });
  await act(async () => {});
  allowed = false;
  let result;
  await act(async () => { release(); result = await admission; });
  expect(result.started).toBe(false);
  expect(send).not.toHaveBeenCalled();

  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  act(() => { admission = store.result.current[11](store.result.current[0], () => true, send); });
  await act(async () => {});
  await act(async () => { store.result.current[1](items => [...items, { name: 'new.txt', path: '/fixture/new.txt' }]); });
  await act(async () => { release(); result = await admission; });
  expect(result.started).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

it('keeps the draft and does not start a send if the coordination lock fails', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-send-lock-error'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  withAttachmentWriteLock.mockRejectedValueOnce(new Error('lock unavailable'));
  const send = vi.fn();
  let result;
  await act(async () => { result = await store.result.current[11](store.result.current[0], () => true, send); });
  expect(result.started).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(store.result.current[0].map(item => item.name)).toEqual(['mine.txt']);
  expect(store.result.current[2]).toMatch(/could not be verified/);
});

it('returns a started send failure without retrying it', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-send-rejected'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  const send = vi.fn().mockRejectedValue(new Error('Synthetic send rejection'));
  let result;
  await act(async () => { result = await store.result.current[11](store.result.current[0], () => true, send); });
  expect(result.started).toBe(true);
  await expect(result.completion).rejects.toThrow('Synthetic send rejection');
  expect(send).toHaveBeenCalledOnce();
  expect(store.result.current[0].map(item => item.name)).toEqual(['mine.txt']);
});

it('can start a text-only send without transaction storage when there are no selected files', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-text-only'));
  withAttachmentWriteLock.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  const send = vi.fn();
  let result;
  await act(async () => { result = await store.result.current[11](store.result.current[0], () => true, send); });
  expect(result.started).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(store.result.current[2]).toBe('');
});

it('does not clear a newer recovery failure when an older pending save finishes', async () => {
  let release;
  withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
  const store = renderHook(() => useComposerFileAttachments('ss-file-newer-failure'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  const original = Storage.prototype.setItem;
  const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (this === sessionStorage && key.includes('composerFileTab:')) throw new Error('session storage unavailable');
    return original.call(this, key, value);
  });
  act(() => store.result.current[1](items => [...items, { name: 'second.txt', path: '/fixture/second.txt' }]));
  expect(store.result.current[2]).toMatch(/could not be saved/);
  mock.mockRestore();
  await act(async () => release());
  expect(store.result.current[10]).toBe(false);
  expect(store.result.current[2]).toMatch(/could not be saved/);
  expect(store.result.current[0].map(item => item.name)).toEqual(['first.txt', 'second.txt']);
  await act(async () => { store.result.current[3](); });
  expect(store.result.current[2]).toBe('');
});

it('retains the tab copy and blocks sending if transactional coordination fails', async () => {
  withAttachmentWriteLock.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  const store = renderHook(() => useComposerFileAttachments('ss-file-lock-unavailable'));
  await act(async () => { store.result.current[1]([{ name: 'kept.txt', path: '/fixture/kept.txt' }]); });
  expect(store.result.current[2]).toMatch(/could not be saved/);
  expect(store.result.current[7]()).toBe(false);
  expect(Object.entries(localStorage).some(([key]) => key.includes('ss-file-lock-unavailable'))).toBe(false);
  expect(Object.entries(sessionStorage).find(([key]) => key.includes('ss-file-lock-unavailable'))[1]).toContain('kept.txt');
});

it('restores only the selected paths for the same account, environment and conversation', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-restore'));
  await act(async () => { first.result.current[1]([{ name: 'notes.txt', path: '/fixture/notes.txt' }]); });
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

it('keeps the restored-file warning while an original restored selection remains', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-restored-warning'));
  await act(async () => { first.result.current[1]([{ name: 'restored.txt', path: '/fixture/restored.txt' }]); });
  first.unmount();
  setEnvironmentIdentity('other-owner', window.location.origin);
  setEnvironmentIdentity('fixture-owner', window.location.origin);
  const restored = renderHook(() => useComposerFileAttachments('ss-file-restored-warning'));
  expect(restored.result.current[4]).toBe(true);
  await act(async () => { restored.result.current[1](items => [...items, { name: 'new.txt', path: '/fixture/new.txt' }]); });
  expect(restored.result.current[4]).toBe(true);
  await act(async () => { restored.result.current[1](items => items.filter(item => item.path !== '/fixture/restored.txt')); });
  expect(restored.result.current[4]).toBe(false);
  expect(restored.result.current[0]).toEqual([{ name: 'new.txt', path: '/fixture/new.txt' }]);
});

it('retains a selection and reports a failed save until storage recovers', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-quota'));
  const original = Storage.prototype.setItem;
  const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key.includes('composerFiles:')) throw new Error('storage full');
    return original.call(this, key, value);
  });
  await act(async () => { store.result.current[1]([{ name: 'quota.txt', path: '/fixture/quota.txt', bytes: 'must not persist' }]); });
  expect(store.result.current[0]).toEqual([{ name: 'quota.txt', path: '/fixture/quota.txt', bytes: 'must not persist' }]);
  expect(store.result.current[2]).toMatch(/could not be saved/);
  mock.mockRestore();
  await act(async () => { store.result.current[3](); });
  expect(store.result.current[2]).toBe('');
  const saved = Object.entries(localStorage).find(([key]) => key.includes('composerFiles:'));
  expect(JSON.parse(saved[1]).items).toEqual([{ name: 'quota.txt', path: '/fixture/quota.txt' }]);
});

it('recovers an unavailable storage read when no saved selection exists', async () => {
  const original = Storage.prototype.getItem;
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
    if (key.includes('composerFiles:')) throw new Error('storage unavailable');
    return original.call(this, key);
  });
  const store = renderHook(() => useComposerFileAttachments('ss-file-read-error'));
  expect(store.result.current[2]).toMatch(/could not be read/);
  getItem.mockRestore();
  await act(async () => { store.result.current[3](); });
  expect(store.result.current[2]).toBe('');
});

it('does not overwrite a different selection saved by another tab', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-conflict'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-conflict', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] });
  localStorage.setItem(key, other);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: other, storageArea: localStorage })));
  expect(store.result.current[2]).toMatch(/another tab/);
  await act(async () => { store.result.current[1](items => [...items, { name: 'later.txt', path: '/fixture/later.txt' }]); });
  expect(localStorage.getItem(key)).toBe(other);
  expect(store.result.current[0].map(item => item.name)).toEqual(['first.txt', 'later.txt']);
  expect(store.result.current[2]).toMatch(/changed in another tab/);
});

it('reports a cross-tab change made while the conversation is not mounted', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-unmounted-conflict'));
  await act(async () => { first.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  first.unmount();
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-unmounted-conflict', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] });
  localStorage.setItem(key, other);

  const reopened = renderHook(() => useComposerFileAttachments('ss-file-unmounted-conflict'));
  expect(reopened.result.current[0]).toEqual([{ name: 'first.txt', path: '/fixture/first.txt' }]);
  expect(reopened.result.current[2]).toMatch(/another tab/);
  expect(localStorage.getItem(key)).toBe(other);
});

it('restores the current tab selection after a cross-tab conflict and reload', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-conflict-reload'));
  await act(async () => { first.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes('ss-file-conflict-reload'));
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-conflict-reload', items: [{ name: 'theirs.txt', path: '/fixture/theirs.txt' }] });
  localStorage.setItem(key, other);
  await act(async () => { first.result.current[1](items => [...items, { name: 'later.txt', path: '/fixture/later.txt' }]); });
  expect(first.result.current[2]).toMatch(/another tab/);
  first.unmount();
  act(() => { setEnvironmentIdentity('other-owner', window.location.origin); setEnvironmentIdentity('fixture-owner', window.location.origin); });
  const reopened = renderHook(() => useComposerFileAttachments('ss-file-conflict-reload'));
  expect(reopened.result.current[0].map(item => item.name)).toEqual(['mine.txt', 'later.txt']);
  expect(reopened.result.current[5].items.map(item => item.name)).toEqual(['theirs.txt']);
  await act(async () => { reopened.result.current[1](items => [...items, { name: 'new.txt', path: '/fixture/new.txt' }]); });
  expect(reopened.result.current[0].map(item => item.name)).toEqual(['mine.txt', 'later.txt', 'new.txt']);
  expect(reopened.result.current[2]).toMatch(/another tab/);
  expect(localStorage.getItem(key)).toBe(other);
});

it('keeps the shared selection unchanged if this tab cannot save its recovery copy', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-tab-quota'));
  await act(async () => { store.result.current[1]([{ name: 'first.txt', path: '/fixture/first.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes('ss-file-tab-quota'));
  const before = localStorage.getItem(key);
  const original = Storage.prototype.setItem;
  const mock = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (storageKey, value) {
    if (this === sessionStorage && storageKey.includes('composerFileTab:')) throw new Error('session storage unavailable');
    return original.call(this, storageKey, value);
  });
  await act(async () => { store.result.current[1](items => [...items, { name: 'second.txt', path: '/fixture/second.txt' }]); });
  expect(store.result.current[0].map(item => item.name)).toEqual(['first.txt', 'second.txt']);
  expect(store.result.current[2]).toMatch(/could not be saved/);
  expect(localStorage.getItem(key)).toBe(before);
  mock.mockRestore();
  await act(async () => { store.result.current[3](); });
  expect(store.result.current[2]).toBe('');
  expect(JSON.parse(localStorage.getItem(key)).items.map(item => item.name)).toEqual(['first.txt', 'second.txt']);
});

it('does not resurrect a replaced selection after adopting saved files and reloading', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-adopt-reload'));
  await act(async () => { first.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes('ss-file-adopt-reload'));
  const other = JSON.stringify({ version: 1, sessionId: 'ss-file-adopt-reload', items: [{ name: 'theirs.txt', path: '/fixture/theirs.txt', bytes: 'private-bytes' }] });
  localStorage.setItem(key, other);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: other, storageArea: localStorage })));
  act(() => { expect(first.result.current[6](first.result.current[5])).toBe(true); });
  expect(Object.entries(sessionStorage).find(([name]) => name.includes('ss-file-adopt-reload'))[1]).not.toContain('private-bytes');
  first.unmount();
  act(() => { setEnvironmentIdentity('other-owner', window.location.origin); setEnvironmentIdentity('fixture-owner', window.location.origin); });
  const reopened = renderHook(() => useComposerFileAttachments('ss-file-adopt-reload'));
  expect(reopened.result.current[0].map(item => item.name)).toEqual(['theirs.txt']);
  expect(reopened.result.current[2]).toBe('');
});

it('does not restore another account’s tab copy before environment identity is set', async () => {
  act(() => setEnvironmentIdentity(null));
  const first = renderHook(() => useComposerFileAttachments('ss-file-tab-account'));
  await act(async () => { first.result.current[1]([{ name: 'private.txt', path: '/fixture/private.txt' }]); });
  first.unmount();
  act(() => setUser({ id: 'another-account' }));
  const second = renderHook(() => useComposerFileAttachments('ss-file-tab-account'));
  expect(second.result.current[0]).toEqual([]);
  expect(second.result.current[2]).toBe('');
});

it('lets the user review and adopt the other tab’s saved selections without writing to storage', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-adopt'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
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

it('keeps the local selection if saved files change after the user reviews them', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-stale-review'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
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

it('invalidates an old upload token in every pane sharing the conversation', async () => {
  const first = renderHook(() => useComposerFileAttachments('ss-file-shared-adoption'));
  const second = renderHook(() => useComposerFileAttachments('ss-file-shared-adoption'));
  await act(async () => { first.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
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

it('does not offer adoption for invalid saved files or after the account changes', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-invalid-review'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
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

it('detects a saved change synchronously before send even if the storage event is delayed', async () => {
  const store = renderHook(() => useComposerFileAttachments('ss-file-pre-send'));
  await act(async () => { store.result.current[1]([{ name: 'mine.txt', path: '/fixture/mine.txt' }]); });
  const key = Object.keys(localStorage).find(value => value.includes('composerFiles:'));
  localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: 'ss-file-pre-send', items: [{ name: 'other.txt', path: '/fixture/other.txt' }] }));
  expect(store.result.current[2]).toBe('');
  act(() => { expect(store.result.current[7]()).toBe(false); });
  expect(store.result.current[0]).toEqual([{ name: 'mine.txt', path: '/fixture/mine.txt' }]);
  expect(store.result.current[2]).toMatch(/another tab/);
});
