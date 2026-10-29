import { describe, expect, it, vi } from 'vitest';
import { retainStartImageDraft } from './startImageDraftLease';

const { current } = vi.hoisted(() => ({ current: vi.fn(() => true) }));
vi.mock('./auth', () => ({ isAuthScopeCurrent: current }));

function fixture() {
  const native = { close: vi.fn(), getSnapshot: () => ({ storageState: 'ready' }) };
  let context;
  const store = { getImageStore: () => null, observeImages: vi.fn(value => { context = value; return native; }) };
  const auth = { userId: 'owner', home: 'https://home.test/' }, controller = new AbortController();
  const options = { store, auth, environmentSignal: controller.signal, isCurrent: () => true };
  return { native, store, auth, controller, options, context: () => context };
}

describe('start image draft ownership', () => {
  it('keeps a shared store open until the last current view leaves', () => {
    const value = fixture();
    const first = retainStartImageDraft(value.options), second = retainStartImageDraft(value.options);
    expect(value.store.observeImages).toHaveBeenCalledOnce();
    first.release();
    expect(value.native.close).not.toHaveBeenCalled();
    expect(second.current()).toBe(true);
    second.release();
    expect(value.native.close).toHaveBeenCalledOnce();
    expect(value.context().isCurrent()).toBe(false);
  });

  it('rejects a different account on a retained store and retires a changed environment', () => {
    const value = fixture(), lease = retainStartImageDraft(value.options);
    expect(() => retainStartImageDraft({ ...value.options, auth: { ...value.auth, userId: 'other' } })).toThrow(/accounts/i);
    value.controller.abort();
    expect(lease.current()).toBe(false);
    expect(value.context().isCurrent()).toBe(false);
    lease.release();
  });
});
