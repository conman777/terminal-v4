import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ports, resetFixture, cleanFixture, SESSION, CATALOG, snapshot, response, nativeBoundary } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
import { apiFetch } from '../utils/api';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { useUserImageComposer } from './useUserImageComposer';

beforeEach(() => {
  resetFixture();
  apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(null, 404));
});
afterEach(cleanFixture);

describe('image receipt expiry at the composer boundary', () => {
  it('rejects expired descriptors even before a scheduled snapshot publication', async () => {
    const store = getComposerDraftStore(SESSION.id), sendMessage = vi.fn();
    nativeBoundary(store);
    const view = renderHook(() => useUserImageComposer({ session: SESSION, active: true, store, sendMessage }));
    await waitFor(() => expect(view.result.current.userImages?.canAdd).toBe(true));
    const ready = snapshot(), deadline = Date.now() + 1000;
    act(() => ports.native.publish({ ...ready, items: ready.items.map(item => ({ ...item, expiresAt: deadline })) }));
    await waitFor(() => expect(view.result.current.userImages.canSend).toBe(true));
    vi.spyOn(Date, 'now').mockReturnValue(deadline);
    await expect(view.result.current.sendDraft('kept caption')).rejects.toThrow(/expired|not ready/i);
    expect(sendMessage.mock.calls).toEqual([]);
    view.unmount();
  });
});
