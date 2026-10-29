import { useLayoutEffect } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompactionControl } from './useCompactionControl';
import { getCompactionIntentStore } from '../utils/compactionIntentStore';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { CONTEXT_SESSION as SID, OTHER_CONTEXT_SESSION, CONTEXT_REVISION, compactResponse as response, contextSnapshot, compactReceipt, commandEvents, contextControlState } from '../test/compactionFixtures';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
let handlePost;
const posts = () => apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
const pending = () => getCompactionIntentStore(SID).getSnapshot().pending;
const options = extra => ({ sessionId: SID, active: true, controlState: contextControlState(), onStopConversation: vi.fn(), ...extra });
const mount = extra => renderHook(props => useCompactionControl(props), { initialProps: options(extra) });
const loaded = hook => waitFor(() => expect(hook.result.current.context?.sessionId).toBe(SID));
async function submit(hook, instructions = 'Preserve exact decisions.\n') {
  act(() => hook.result.current.setInstructions(instructions));
  await act(async () => { await hook.result.current.submit(); });
}
beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear(); setEnvironmentIdentity('compact-hook-owner', 'https://home.example/base'); setActiveEnvironment(null);
  handlePost = async (_url, options) => response(compactReceipt(options.body.requestId), 202);
  apiFetch.mockReset(); apiFetch.mockImplementation(async (url, opts = {}) => {
    if (opts.method === 'POST') return handlePost(url, opts);
    if (url.endsWith('/context')) return response(contextSnapshot({ sessionId: url.includes(OTHER_CONTEXT_SESSION) ? OTHER_CONTEXT_SESSION : SID }));
    if (url.includes('/requests/')) return response({ error: 'Not found' }, 404);
    return response({ id: SID, runtime: 'v4', events: [] });
  });
});
afterEach(() => { vi.restoreAllMocks(); setEnvironmentIdentity(null); setActiveEnvironment(null); localStorage.clear(); });

describe('actual useCompactionControl request, scope and recovery behavior', () => {
  it('loads only local context on open, never POSTs or Stops automatically', async () => {
    const stop = vi.fn(), hook = mount({ onStopConversation: stop }); await loaded(hook);
    expect(apiFetch).toHaveBeenCalledTimes(1); expect(apiFetch.mock.calls[0][0]).toBe(`/api/structured/sessions/${SID}/context`);
    expect(posts()).toHaveLength(0); hook.unmount(); expect(stop).not.toHaveBeenCalled();
  });
  it('performs no request while the dialog is inactive', () => {
    mount({ active: false }); expect(apiFetch).not.toHaveBeenCalled();
  });
  it('does not fall back to a different host when paired context reads are unsupported', async () => {
    setActiveEnvironment({ id: 'paired-fixture', capabilities: { agentExecute: true } });
    const hook = mount(); await waitFor(() => expect(hook.result.current.error).toMatch(/local|paired|available/i));
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('persists the exact compact intent before its POST and accepts omitted messageId', async () => {
    const hook = mount(); await loaded(hook);
    handlePost = async (url, opts) => {
      expect(url).toBe(`/api/structured/sessions/${SID}/compact`); expect(pending().body).toEqual(opts.body);
      expect(opts.body).toMatchObject({ instructions: '  exact\n', expectedRevision: CONTEXT_REVISION });
      expect(Object.keys(opts.body).sort()).toEqual(['expectedRevision', 'instructions', 'requestId']);
      return response(compactReceipt(opts.body.requestId), 202);
    };
    await submit(hook, '  exact\n'); expect(hook.result.current.pending.receipt.status).toBe('accepted');
    expect(hook.result.current.instructions).toBe(''); expect(posts()).toHaveLength(1);
  });
  it('does not POST when required device persistence fails', async () => {
    const hook = mount(); await loaded(hook); act(() => hook.result.current.setInstructions('keep draft'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota'); });
    await act(async () => { await hook.result.current.submit(); });
    expect(posts()).toHaveLength(0); expect(hook.result.current.instructions).toBe('keep draft'); expect(hook.result.current.error).toMatch(/save|storage/i);
  });
  it('preserves newer instructions while an earlier command is accepted', async () => {
    const hook = mount(); await loaded(hook); let finish;
    handlePost = (_url, opts) => new Promise(resolve => { finish = () => resolve(response(compactReceipt(opts.body.requestId), 202)); });
    act(() => hook.result.current.setInstructions('old')); let task;
    act(() => { task = hook.result.current.submit(); });
    act(() => { hook.result.current.setInstructions('edited'); hook.result.current.setInstructions('old'); });
    await act(async () => { finish(); await task; }); expect(hook.result.current.instructions).toBe('old');
  });
  it('rejects initial definite conflicts without changing instructions or automatically resubmitting', async () => {
    const hook = mount(); await loaded(hook); handlePost = async () => response({ error: 'Revision changed' }, 409);
    await submit(hook, 'keep draft'); expect(hook.result.current.instructions).toBe('keep draft');
    expect(hook.result.current.pending).toBeNull(); expect(posts()).toHaveLength(1); expect(hook.result.current.error).toMatch(/revision|changed/i);
  });
  it('retains identity on a malformed acceptance rather than treating it as definite rejection', async () => {
    const hook = mount(); await loaded(hook); handlePost = async () => response({ status: 'accepted' }, 202);
    await submit(hook); expect(pending()?.body.requestId).toBeTruthy(); expect(hook.result.current.instructions).toBe('Preserve exact decisions.\n');
    expect(hook.result.current.error).toMatch(/receipt|confirm|unknown/i);
  });
  it.each([400, 401, 403, 404, 409, 413, 422])('retains a lost original UUID after lookup404 and explicit retry HTTP%s', async status => {
    const hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
    await submit(hook); const original = structuredClone(pending().body);
    act(() => hook.result.current.setInstructions('newer instructions do not replace frozen body'));
    handlePost = async () => response({ error: 'Synthetic retry rejection' }, status);
    await act(async () => { await hook.result.current.retry(); });
    expect(posts()).toHaveLength(2); expect(posts()[1][1].body).toEqual(original); expect(pending().body).toEqual(original);
    const calls = apiFetch.mock.calls, retryIndex = calls.findLastIndex(([, opts]) => opts?.method === 'POST');
    expect(calls.slice(1, retryIndex).some(([url]) => url.endsWith('/requests/' + original.requestId))).toBe(true);
    expect(hook.result.current.instructions).toBe('newer instructions do not replace frozen body');
  });
  it('reopens a persisted uncertain command with reads only and no automatic POST replay', async () => {
    let hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
    await submit(hook); const original = pending().body; hook.unmount(); apiFetch.mockClear();
    hook = mount(); await loaded(hook);
    await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.endsWith('/requests/' + original.requestId))).toBe(true));
    expect(posts()).toHaveLength(0); expect(pending().body).toEqual(original);
  });
  it('keeps an uncertain UUID if receipt lookup is forbidden, without reposting', async () => {
    const hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
    await submit(hook); const original = pending().body;
    apiFetch.mockImplementation(async url => url.includes('/requests/') ? response({ error: 'Forbidden' }, 403) : response(contextSnapshot()));
    apiFetch.mockClear(); await act(async () => { await hook.result.current.retry(); });
    expect(posts()).toHaveLength(0); expect(pending().body).toEqual(original);
  });
  it('resolves an exact canonical command without adding a user message or replacing its identity', async () => {
    const hook = mount(); await loaded(hook); await submit(hook); const body = pending().body;
    hook.rerender(options({ controlState: contextControlState(commandEvents(body)) }));
    await waitFor(() => expect(hook.result.current.outcome?.status).toBe('completed'));
    expect(hook.result.current.outcome.receipt.afterBytes).toBe(31000); expect(hook.result.current.pending).toBeNull(); expect(posts()).toHaveLength(1);
  });
  it('treats durable completion separately from a conversation cleanup barrier', async () => {
    const hook = mount(); await loaded(hook); await submit(hook); const body = pending().body;
    hook.rerender(options({ requiresCleanup: true, controlState: contextControlState(commandEvents(body)) }));
    await waitFor(() => expect(hook.result.current.outcome?.status).toBe('completed'));
    expect(hook.result.current.canSubmit).toBe(false); expect(hook.result.current.requiresCleanup).toBe(true);
  });
  it('ignores controls for another session or an older replay generation', async () => {
    const hook = mount({ controlState: contextControlState([], { generation: 2 }) }); await loaded(hook); await submit(hook); const body = pending().body;
    hook.rerender(options({ controlState: contextControlState(commandEvents(body), { sessionId: OTHER_CONTEXT_SESSION, generation: 3 }) }));
    expect(hook.result.current.outcome).toBeNull(); expect(pending().body).toEqual(body);
    hook.rerender(options({ controlState: contextControlState(commandEvents(body), { generation: 1 }) }));
    expect(hook.result.current.outcome).toBeNull();
  });
  it('fences a late context response across an account/session switch', async () => {
    let finish; apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const hook = mount();
    act(() => setEnvironmentIdentity('other-context-owner', 'https://home.example/base'));
    hook.rerender(options({ sessionId: OTHER_CONTEXT_SESSION, controlState: contextControlState([], { sessionId: OTHER_CONTEXT_SESSION }) }));
    await waitFor(() => expect(hook.result.current.context?.sessionId).toBe(OTHER_CONTEXT_SESSION));
    await act(async () => finish(response(contextSnapshot())));
    expect(hook.result.current.context.sessionId).toBe(OTHER_CONTEXT_SESSION); expect(posts()).toHaveLength(0);
  });
  it('does not accept a partial snapshot as proof of an unrelated compact result', async () => {
    const hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
    await submit(hook); const original = pending().body;
    apiFetch.mockImplementation(async url => url.includes('/requests/') ? response(compactReceipt(original.requestId, { status: 'completed' })) : url.endsWith('/context') ? response(contextSnapshot()) : response({ id: SID, runtime: 'v4', events: commandEvents({ ...original, instructions: 'foreign body' }) }));
    await act(async () => { await hook.result.current.reconcile(); });
    expect(pending().body).toEqual(original); expect(hook.result.current.outcome).toBeNull(); expect(posts()).toHaveLength(1);
  });
  it('uses explicit shared Stop conversation without inferring compaction cancellation', async () => {
    const stop = vi.fn().mockResolvedValue({ accepted: true, status: 'cancelled', cleanupConfirmed: true });
    const hook = mount({ onStopConversation: stop }); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
    await submit(hook); const original = pending().body;
    expect(stop).not.toHaveBeenCalled(); await act(async () => { await hook.result.current.stopConversation(); });
    expect(stop).toHaveBeenCalledTimes(1); expect(pending().body).toEqual(original); expect(hook.result.current.outcome).toBeNull();
    hook.unmount(); expect(stop).toHaveBeenCalledTimes(1);
  });
  it.each([{ conversationBusy: true }, { requiresCleanup: true }, { readOnly: true }])('prevents submission for the explicit conversation barrier %j', async change => {
    const hook = mount(change); await loaded(hook); await submit(hook); expect(posts()).toHaveLength(0); expect(hook.result.current.canSubmit).toBe(false);
  });
});

it('finds the exact canonical command after receipt404 and does not repost an accepted original', async () => {
  const hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
  await submit(hook); const original = pending().body;
  apiFetch.mockImplementation(async url => url.includes('/requests/') ? response({ error: 'Not found' }, 404) : url.endsWith('/context') ? response(contextSnapshot()) : response({ id: SID, runtime: 'v4', events: commandEvents(original).slice(0, 2) }));
  await act(async () => { await hook.result.current.retry(); });
  expect(posts()).toHaveLength(1); expect(pending().body).toEqual(original); expect(hook.result.current.pending.receipt.status).toBe('running');
});
it('retains an original UUID if terminal lookup exists but canonical command proof is absent', async () => {
  const hook = mount(); await loaded(hook); handlePost = async () => { throw new TypeError('Synthetic lost response'); };
  await submit(hook); const original = pending().body;
  apiFetch.mockImplementation(async url => url.includes('/requests/') ? response(compactReceipt(original.requestId, { status: 'completed' })) : url.endsWith('/context') ? response(contextSnapshot()) : response({ id: SID, runtime: 'v4', events: [] }));
  await act(async () => { await hook.result.current.retry(); });
  expect(posts()).toHaveLength(1); expect(pending().body).toEqual(original); expect(hook.result.current.outcome).toBeNull();
});
it('fences a late parsed POST acceptance across account ABA and keeps its original persisted identity/draft', async () => {
  const hook = mount(); await loaded(hook); let parse;
  handlePost = async () => ({ ok: true, status: 202, json: () => new Promise(resolve => { parse = resolve; }) });
  act(() => hook.result.current.setInstructions('late parsed original')); let task;
  await act(async () => { task = hook.result.current.submit(); await Promise.resolve(); }); const original = pending().body;
  act(() => { setEnvironmentIdentity('temporary-owner', 'https://home.example/base'); setEnvironmentIdentity('compact-hook-owner', 'https://home.example/base'); });
  await loaded(hook);
  await act(async () => { parse(compactReceipt(original.requestId)); await task; });
  expect(pending().body).toEqual(original); expect(pending().receipt).toBeNull();
  expect(hook.result.current.instructions).toBe('late parsed original'); expect(hook.result.current.outcome).toBeNull();
});
it('shares a same-window lease so two mounted controls cannot submit two command identities', async () => {
  const first = mount(), second = mount(); await loaded(first); await loaded(second); let finish;
  handlePost = (_url, opts) => new Promise(resolve => { finish = () => resolve(response(compactReceipt(opts.body.requestId), 202)); });
  act(() => first.result.current.setInstructions('one command')); let task;
  act(() => { task = first.result.current.submit(); });
  await act(async () => { await second.result.current.submit(); }); expect(posts()).toHaveLength(1);
  await act(async () => { finish(); await task; });
  expect(first.result.current.pending.body.requestId).toBe(second.result.current.pending.body.requestId);
});
it.each([{ accepted: false }, { accepted: true, reconciled: true }])('does not confirm Stop from partial result %j or clear an uncertain compact identity', async stopResult => {
  const stop = vi.fn().mockResolvedValue(stopResult), hook = mount({ onStopConversation: stop }); await loaded(hook);
  handlePost = async () => { throw new TypeError('Synthetic lost response'); }; await submit(hook); const original = pending().body;
  await act(async () => { await hook.result.current.stopConversation(); });
  expect(hook.result.current.stopFailure).toMatch(/not.*confirmed|could not.*confirm/i);
  expect(pending().body).toEqual(original); expect(hook.result.current.outcome).toBeNull();
});
it('blocks compact when the current local sample gives the queue priority', async () => {
  apiFetch.mockResolvedValue(response(contextSnapshot({ canCompact: false, blockedReason: 'queue_has_priority' })));
  const hook = mount(); await loaded(hook); await submit(hook); expect(posts()).toHaveLength(0); expect(hook.result.current.canSubmit).toBe(false);
});

it('does not overwrite a newer explicit refresh with an older same-scope GET', async () => {
  let initial; apiFetch.mockImplementationOnce(() => new Promise(resolve => { initial = resolve; }));
  const hook = mount(); apiFetch.mockResolvedValueOnce(response(contextSnapshot({ asOfSeq: 20, conversationRevision: 'b'.repeat(64) })));
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.context.asOfSeq).toBe(20);
  await act(async () => initial(response(contextSnapshot({ asOfSeq: 8 }))));
  expect(hook.result.current.context.asOfSeq).toBe(20);
});
it('invalidates a sampled meter when shared latestSeq advances even with no selected control events', async () => {
  const hook = mount(); await loaded(hook);
  hook.rerender(options({ controlState: contextControlState([], { latestSeq: 9 }) }));
  expect(hook.result.current.sampleStale).toBe(true); expect(hook.result.current.canSubmit).toBe(false);
  apiFetch.mockResolvedValueOnce(response(contextSnapshot({ asOfSeq: 9 })));
  await act(async () => { await hook.result.current.reload(); }); expect(hook.result.current.sampleStale).toBe(false);
});
it('retains an accepted command across close/reopen until read-only canonical terminal reconciliation', async () => {
  const first = mount(); await loaded(first); await submit(first); const original = pending().body; first.unmount(); apiFetch.mockClear();
  apiFetch.mockImplementation(async url => url.endsWith('/context') ? response(contextSnapshot({ asOfSeq: 12 })) : url.includes('/requests/') ? response(compactReceipt(original.requestId, { status: 'completed' })) : response({ id: SID, runtime: 'v4', events: commandEvents(original) }));
  const second = mount(); await loaded(second); await waitFor(() => expect(second.result.current.outcome?.status).toBe('completed'));
  expect(pending()).toBeNull(); expect(posts()).toHaveLength(0);
});

it('lets canonical committed completion win over a later lost POST response', async () => {
  const hook = mount(); await loaded(hook); let fail;
  handlePost = () => new Promise((_resolve, reject) => { fail = reject; });
  act(() => hook.result.current.setInstructions('committed original')); let task;
  act(() => { task = hook.result.current.submit(); }); const original = pending().body;
  hook.rerender(options({ controlState: contextControlState(commandEvents(original)) }));
  await waitFor(() => expect(hook.result.current.outcome?.status).toBe('completed'));
  await act(async () => { fail(new TypeError('Late lost POST')); await task; });
  expect(hook.result.current.pending).toBeNull(); expect(hook.result.current.outcome.status).toBe('completed'); expect(hook.result.current.error).toBe('');
});
it('invalidates an earlier usable sample when an explicit refresh returns malformed current data', async () => {
  const hook = mount(); await loaded(hook); apiFetch.mockResolvedValueOnce(response(contextSnapshot({ measurementScope: 'invented' })));
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.context).toBeNull(); expect(hook.result.current.canSubmit).toBe(false); expect(hook.result.current.error).toMatch(/invalid context/i);
});

it('invalidates an old sample after canonical replay reset even when latestSeq is lower', async () => {
  const hook = mount(); await loaded(hook);
  hook.rerender(options({ controlState: contextControlState([], { generation: 2, latestSeq: 0 }) }));
  expect(hook.result.current.sampleStale).toBe(true); expect(hook.result.current.canSubmit).toBe(false);
});

it.each([
  { generation: 1, latestSeq: 20, truncated: true },
  { generation: 2, latestSeq: 0, truncated: false },
])('recovers a pending command with GET-only canonical fallback on control marker %j', async marker => {
  const hook = mount(); await loaded(hook); await submit(hook); const original = pending().body;
  apiFetch.mockImplementation(async url => url.endsWith('/context') ? response(contextSnapshot({ asOfSeq: 20 })) : url.includes('/requests/') ? response({ error: 'Not found' }, 404) : response({ id: SID, runtime: 'v4', events: commandEvents(original) }));
  hook.rerender(options({ controlState: contextControlState([], marker) }));
  await waitFor(() => expect(hook.result.current.outcome?.status).toBe('completed'));
  expect(posts()).toHaveLength(1); expect(pending()).toBeNull();
});
it('coalesces duplicate truncation recovery markers without automatic POST or repeated reads', async () => {
  const hook = mount(); await loaded(hook); await submit(hook); const original = pending().body;
  apiFetch.mockImplementation(async url => url.endsWith('/context') ? response(contextSnapshot()) : url.includes('/requests/') ? response(compactReceipt(original.requestId, { status: 'running' })) : response({ id: SID, runtime: 'v4', events: commandEvents(original).slice(0, 2) }));
  apiFetch.mockClear(); const controls = contextControlState([], { latestSeq: 20, truncated: true });
  hook.rerender(options({ controlState: controls }));
  await waitFor(() => expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.isSubmitting).toBe(false));
  hook.rerender(options({ controlState: { ...controls } }));
  await act(async () => { await Promise.resolve(); });
  expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(1); expect(posts()).toHaveLength(0);
});
it.each([{ sessionId: OTHER_CONTEXT_SESSION }, { active: false }])('synchronously rejects old-scope actions before passive cleanup for %j', async next => {
  let task;
  const hook = renderHook(props => {
    const control = useCompactionControl(props);
    useLayoutEffect(() => { props.onLayout?.(control); }, [props.onLayout]);
    return control;
  }, { initialProps: options() });
  await loaded(hook); act(() => hook.result.current.setInstructions('old scope instructions'));
  hook.rerender(options({ ...next, onLayout: control => { task = control.submit(); } }));
  await act(async () => { await task; });
  expect(posts()).toHaveLength(0);
});

it('does not reread on every truncated latestSeq and later recovers an evicted-command terminal by its accepted turn', async () => {
  const hook = mount(); await loaded(hook); await submit(hook); const original = pending().body;
  let terminal = false;
  apiFetch.mockImplementation(async url => url.endsWith('/context') ? response(contextSnapshot({ asOfSeq: 30 })) : url.includes('/requests/') ? response(compactReceipt(original.requestId, { status: terminal ? 'completed' : 'running' })) : response({ id: SID, runtime: 'v4', events: terminal ? commandEvents(original) : commandEvents(original).slice(0, 2) }));
  apiFetch.mockClear(); hook.rerender(options({ controlState: contextControlState([], { latestSeq: 20, truncated: true }) }));
  await waitFor(() => expect(hook.result.current.pending?.receipt.status).toBe('running'));
  expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(1);
  hook.rerender(options({ controlState: contextControlState([], { latestSeq: 21, truncated: true }) }));
  await act(async () => { await Promise.resolve(); });
  expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(1);
  terminal = true; hook.rerender(options({ controlState: contextControlState(commandEvents(original).slice(2), { latestSeq: 30, truncated: true }) }));
  await waitFor(() => expect(hook.result.current.outcome?.status).toBe('completed'));
  expect(apiFetch.mock.calls.filter(([url]) => url.includes('/requests/'))).toHaveLength(2); expect(posts()).toHaveLength(0);
});

it('synchronously rejects a replay reset before passive control projection cleanup', async () => {
  apiFetch.mockResolvedValueOnce(response(contextSnapshot({ asOfSeq: 10 })));
  let task;
  const hook = renderHook(props => {
    const control = useCompactionControl(props);
    useLayoutEffect(() => { props.onLayout?.(control); }, [props.onLayout]);
    return control;
  }, { initialProps: options({ controlState: contextControlState([], { generation: 1, latestSeq: 10 }) }) });
  await loaded(hook); act(() => hook.result.current.setInstructions('reviewed against generation one'));
  hook.rerender(options({ controlState: contextControlState([], { generation: 2, latestSeq: 0 }), onLayout: control => { task = control.submit(); } }));
  await act(async () => { await task; });
  expect(posts()).toHaveLength(0);
});

it('does not let a pre-reset refresh response restore sample authority after a newer replay generation', async () => {
  const hook = mount(); await loaded(hook); let finish, refresh;
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => { refresh = hook.result.current.reload(); });
  hook.rerender(options({ controlState: contextControlState([], { generation: 2, latestSeq: 0 }) }));
  await act(async () => { finish(response(contextSnapshot({ asOfSeq: 10 }))); await refresh; });
  expect(hook.result.current.sampleStale).toBe(true); expect(hook.result.current.canSubmit).toBe(false);
  apiFetch.mockResolvedValueOnce(response(contextSnapshot({ asOfSeq: 12 })));
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.sampleStale).toBe(false); expect(hook.result.current.canSubmit).toBe(true);
});
