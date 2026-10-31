import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'fixture-token', isAccessTokenExpired: () => false, refreshTokens: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
class Socket {
  static instances = [];
  constructor(url) { this.url = url; this.closed = false; Socket.instances.push(this); }
  close() { this.closed = true; this.onclose?.({ code: 1000 }); }
}
const originalSocket = globalThis.WebSocket;
const receipt = (requestId, overrides = {}) => ({ status: 'accepted', requestId, turnId: 'turn-fixture', messageId: 'message-fixture', acceptedSeq: 1, ...overrides });
const emit = event => Socket.instances.at(-1).onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
const renderSession = (sessionId = 'ss-v4', active = false) => renderHook(() => useStructuredSession({ sessionId, active, runtime: 'v4' }));
describe('owned V4 structured session contract', () => {
  beforeEach(() => { setActiveEnvironment(null); apiFetch.mockReset(); Socket.instances = []; globalThis.WebSocket = Socket; });
  afterEach(() => { globalThis.WebSocket = originalSocket; });
  it.each([
    ['cancelled', 'cancelled'], ['interrupted', 'interrupted'], ['failed', 'failed'], ['completed', 'unconfirmed'],
  ])('keeps validated messages complete and marks unfinished output when a turn ends as %s', async (status, expected) => {
    const { result } = renderSession('ss-v4-outcome', true);
    await act(async () => { await Promise.resolve(); });
    act(() => [
      { type: 'turn_started', turnId: 'turn-a' },
      { type: 'message_delta', role: 'assistant', messageId: 'first', turnId: 'turn-a', content: 'First validated message' },
      { type: 'message_completed', role: 'assistant', messageId: 'first', turnId: 'turn-a', content: 'First validated message' },
      { type: 'message_delta', role: 'assistant', messageId: 'partial', turnId: 'turn-a', content: 'Later tentative output' },
      { type: 'turn_completed', turnId: 'turn-a', status },
    ].forEach((event, index) => emit({ seq: index + 1, ...event })));
    expect(result.current.messages).toEqual([
      expect.objectContaining({ messageId: 'first', content: 'First validated message', streaming: false, completionStatus: 'completed' }),
      expect.objectContaining({ messageId: 'partial', content: 'Later tentative output', streaming: false, completionStatus: expected }),
    ]);
    expect(result.current.isStreaming).toBe(false);
  });

  it('marks an older turn stopped without stopping a newer active turn', async () => {
    const { result } = renderSession('ss-v4-outcome-order', true);
    await act(async () => { await Promise.resolve(); });
    act(() => [
      { type: 'turn_started', turnId: 'old' },
      { type: 'message_delta', role: 'assistant', messageId: 'old-message', turnId: 'old', content: 'Old tentative output' },
      { type: 'turn_started', turnId: 'new' },
      { type: 'message_delta', role: 'assistant', messageId: 'new-message', turnId: 'new', content: 'New live output' },
      { type: 'turn_completed', turnId: 'old', status: 'cancelled' },
    ].forEach((event, index) => emit({ seq: index + 1, ...event })));
    expect(result.current.messages).toEqual([
      expect.objectContaining({ messageId: 'old-message', streaming: false, completionStatus: 'cancelled' }),
      expect.objectContaining({ messageId: 'new-message', streaming: true, completionStatus: 'streaming' }),
    ]);
    expect(result.current.isStreaming).toBe(true);
  });
  it('sends a UUID and returns only a matching durable acceptance receipt', async () => {
    apiFetch.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(options.body.requestId) }));
    const { result } = renderSession();
    let response;
    await act(async () => { response = await result.current.sendMessage('Owned question'); });
    const body = apiFetch.mock.calls[0][1].body;
    expect(body).toEqual({ text: 'Owned question\n', fallbackToMessage: true, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(response).toEqual({ accepted: true, ...receipt(body.requestId) });
    expect(result.current.messages).toEqual([expect.objectContaining({ role: 'user', content: 'Owned question', requestId: body.requestId, messageId: 'message-fixture', turnId: 'turn-fixture' })]);
  });
  it('keeps a draft when HTTP succeeds without a matching durable receipt', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => receipt('wrong-request') });
    apiFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const { result } = renderSession();
    await act(async () => { await expect(result.current.sendMessage('Keep it')).rejects.toThrow(/confirm/i); });
    expect(result.current.messages).toEqual([]);
    expect(result.current.actionError).toMatch(/draft.*kept/i);
  });
  it('reconciles canonical user acceptance with delayed HTTP receipts and replay without duplicates', async () => {
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { result } = renderSession('ss-v4-events', true);
    await act(async () => { await Promise.resolve(); });
    let pending;
    act(() => { pending = result.current.sendMessage('Canonical question'); });
    const requestId = apiFetch.mock.calls[0][1].body.requestId;
    act(() => {
      emit({ seq: 1, ts: 10, type: 'user_message_accepted', requestId, turnId: 'turn-fixture', messageId: 'message-fixture', content: 'Canonical question' });
      emit({ seq: 2, ts: 11, type: 'message_delta', role: 'assistant', turnId: 'turn-fixture', messageId: 'answer-fixture', content: 'Canonical answer' });
    });
    await act(async () => { resolve({ ok: true, json: async () => receipt(requestId) }); await pending; });
    act(() => emit({ seq: 3, type: 'user_message_accepted', requestId, turnId: 'turn-fixture', messageId: 'message-fixture', content: 'Canonical question' }));
    expect(result.current.messages.map(message => [message.role, message.content])).toEqual([['user', 'Canonical question'], ['assistant', 'Canonical answer']]);
    expect(result.current.messages[0].seq).toBe(1);
  });
  it('keeps the retry ID for ambiguous same-text retries and changes it for edited text', async () => {
    const bodies = [];
    apiFetch.mockImplementation(async (_url, options) => {
      if (!options?.body) return { ok: false, status: 404 };
      bodies.push(options.body); throw new TypeError('Fixture connection lost');
    });
    const { result } = renderSession();
    for (const text of ['Same draft', 'Same draft', 'Changed draft']) {
      await act(async () => { await expect(result.current.sendMessage(text)).rejects.toThrow(/confirm/i); });
    }
    expect(bodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(bodies[1].requestId).toBe(bodies[0].requestId);
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(3);
  });
  it('confirms an uncertain send with durable lookup without automatically resending', async () => {
    let requestId;
    apiFetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') { requestId = options.body.requestId; throw new TypeError('Receipt lost'); }
      expect(url).toBe(`/api/structured/sessions/ss-v4/requests/${requestId}`);
      return { ok: true, json: async () => receipt(requestId, { status: 'completed' }) };
    });
    const { result } = renderSession();
    let response;
    await act(async () => { response = await result.current.sendMessage('Accepted once'); });
    expect(response).toMatchObject({ accepted: true, requestId, status: 'completed' });
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(result.current.messages.map(message => message.content)).toEqual(['Accepted once']);
    expect(result.current.actionError).toBe('');
  });
  it('correlates assistant and tool messages by IDs during interleaved output and waits for turn completion', async () => {
    const { result } = renderSession('ss-v4-correlation', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      [
        { type: 'turn_started', turnId: 'turn-a' },
        { type: 'message_delta', role: 'assistant', messageId: 'answer-a', turnId: 'turn-a', content: 'Working' },
        { type: 'tool_started', toolCallId: 'tool-a', turnId: 'turn-a', toolName: 'read_file', toolInput: { path: 'fixture.txt' } },
        { type: 'tool_output', toolCallId: 'tool-a', turnId: 'turn-a', output: 'partial' },
        { type: 'tool_completed', toolCallId: 'tool-a', turnId: 'turn-a', result: 'fixture output', isError: false },
        { type: 'message_delta', role: 'assistant', messageId: 'answer-a', turnId: 'turn-a', content: ' done' },
        { type: 'message_completed', role: 'assistant', messageId: 'answer-a', turnId: 'turn-a', content: 'Working done' },
      ].forEach((event, index) => emit({ seq: index + 1, ts: index, ...event }));
    });
    expect(result.current.messages.map(message => [message.role, message.content ?? message.result, message.messageId ?? message.toolCallId, message.turnId])).toEqual([
      ['assistant', 'Working done', 'answer-a', 'turn-a'], ['tool', 'fixture output', 'tool-a', 'turn-a'],
    ]);
    expect(result.current.currentToolCalls).toEqual([]);
    expect(result.current.isStreaming).toBe(true);
    act(() => emit({ seq: 8, type: 'turn_completed', turnId: 'turn-a', status: 'completed' }));
    expect(result.current.isStreaming).toBe(false);
  });
  it('scopes reused provider tool call IDs to their owning turn and ignores older completions', async () => {
    const { result } = renderSession('ss-reused-tool-id', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      [
        { type: 'tool_started', turnId: 'turn-first', toolCallId: 'provider-reused', toolName: 'read_file', toolInput: { path: 'first.txt' } },
        { type: 'tool_completed', turnId: 'turn-first', toolCallId: 'provider-reused', result: 'First result' },
        { type: 'tool_started', turnId: 'turn-second', toolCallId: 'provider-reused', toolName: 'read_file', toolInput: { path: 'second.txt' } },
        { type: 'tool_output', turnId: 'turn-first', toolCallId: 'provider-reused', output: 'Stale first output' },
        { type: 'tool_completed', turnId: 'turn-first', toolCallId: 'provider-reused', result: 'Stale completion' },
      ].forEach((event, index) => emit({ seq: index + 1, ...event }));
    });
    expect(result.current.currentToolCalls).toEqual([expect.objectContaining({ turnId: 'turn-second', result: null })]);
    act(() => emit({ seq: 6, type: 'tool_completed', turnId: 'turn-second', toolCallId: 'provider-reused', result: 'Second result' }));
    expect(result.current.messages.filter(message => message.role === 'tool').map(message => [message.turnId, message.result])).toEqual([['turn-first', 'First result'], ['turn-second', 'Second result']]);
  });
  it('binds decisions to the displayed server approval ID and accepts an identical decision receipt', async () => {
    const { result } = renderSession('ss-v4-approval', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'approval-a', turnId: 'turn-a', toolCallId: 'tool-a', expiresAt: '2026-10-17T03:00:00Z', toolName: 'run_command', toolInput: { command: 'fixture' } }));
    const approval = result.current.pendingApproval;
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'already_decided', approvalId: 'approval-a', approved: false }) });
    await act(async () => { expect(await result.current.approve(false, approval)).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls[0][1].body).toEqual({ approved: false, approvalId: 'approval-a' });
    expect(approval).toMatchObject({ approvalId: 'approval-a', turnId: 'turn-a', toolCallId: 'tool-a', expiresAt: '2026-10-17T03:00:00Z' });
    expect(result.current.pendingApproval).toBeNull();
  });
  it('refuses an owned V4 approval without an action ID rather than submitting an unbound boolean', async () => {
    const { result } = renderSession('ss-v4-missing-id', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', toolName: 'run_command', toolInput: {} }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.current.actionError).toMatch(/approval.*ID|action.*ident/i);
    expect(result.current.pendingApproval).not.toBeNull();
  });
  it('keeps pending approval when HTTP succeeds with a mismatched action or decision receipt', async () => {
    const { result } = renderSession('ss-v4-wrong-id', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'approval-a', toolName: 'run_command', toolInput: {} }));
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'accepted', approvalId: 'approval-b', approved: true }) });
    await act(async () => { await result.current.approve(true, result.current.pendingApproval); });
    expect(result.current.pendingApproval?.approvalId).toBe('approval-a');
    expect(result.current.actionError).toMatch(/confirm/i);
  });
  it('only clears the matching approval when another client or expiry resolves an action', async () => {
    const { result } = renderSession('ss-v4-resolved', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'approval-current', turnId: 'turn-current', toolName: 'run_command' });
      emit({ seq: 2, type: 'approval_resolved', approvalId: 'approval-old', turnId: 'turn-old', approved: false });
    });
    expect(result.current.pendingApproval?.approvalId).toBe('approval-current');
    act(() => emit({ seq: 3, type: 'approval_resolved', approvalId: 'approval-current', turnId: 'turn-current', approved: false, reason: 'expired' }));
    expect(result.current.pendingApproval).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('orders historical canonical messages before a new receipt that arrived before websocket replay', async () => {
    apiFetch.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(options.body.requestId, { acceptedSeq: 10 }) }));
    const { result } = renderSession('ss-v4-history', true);
    await act(async () => { await result.current.sendMessage('New question'); });
    const requestId = apiFetch.mock.calls[0][1].body.requestId;
    act(() => {
      emit({ seq: 1, type: 'user_message_accepted', requestId: 'historical-request', messageId: 'old-user', turnId: 'old-turn', content: 'Old question' });
      emit({ seq: 2, type: 'message_completed', role: 'assistant', messageId: 'old-answer', turnId: 'old-turn', content: 'Old answer' });
      for (let seq = 3; seq < 10; seq += 1) emit({ seq, type: 'status', status: 'idle' });
      emit({ seq: 10, type: 'user_message_accepted', requestId, messageId: 'message-fixture', turnId: 'turn-fixture', content: 'New question' });
    });
    expect(result.current.messages.map(message => message.content)).toEqual(['Old question', 'Old answer', 'New question']);
  });
  it('checks a durable receipt after an ambiguous server failure without retrying the POST', async () => {
    let requestId;
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { requestId = options.body.requestId; return { ok: false, status: 503, json: async () => ({ error: 'Proxy receipt lost' }) }; }
      return { ok: true, json: async () => receipt(requestId) };
    });
    const { result } = renderSession();
    await act(async () => { expect(await result.current.sendMessage('Accepted through proxy')).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('preserves typed owned image refs on the matching completed tool', async () => {
    const { result } = renderSession('ss-v4-images', true);
    await act(async () => { await Promise.resolve(); });
    const content = [{ type: 'text', text: 'Fixture image' }, { type: 'v4_image', artifactId: 'a'.repeat(64), mimeType: 'image/png' }];
    act(() => {
      emit({ seq: 1, type: 'tool_started', turnId: 'turn-image', toolCallId: 'tool-image', toolName: 'fixture_image', toolInput: {} });
      emit({ seq: 2, type: 'tool_completed', turnId: 'turn-image', toolCallId: 'tool-image', result: 'Fixture image', content, isError: false });
    });
    expect(result.current.messages).toEqual([expect.objectContaining({ role: 'tool', toolCallId: 'tool-image', content })]);
  });

  it('retains the turn and pending action on failed or unconfirmed interrupt and permits a single-flight retry', async () => {
    const { result } = renderSession('ss-v4-stop', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'turn_started', turnId: 'turn-stop' });
      emit({ seq: 2, type: 'approval_required', approvalId: 'approval-stop', turnId: 'turn-stop', toolName: 'run_command', toolInput: {} });
    });
    const approval = result.current.pendingApproval;
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending;
    act(() => { pending = result.current.interrupt(); });
    expect(result.current.isInterrupting).toBe(true);
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: false, pending: true }); });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: false, status: 503, json: async () => ({ error: 'Cleanup is not confirmed.' }) }); await pending; });
    expect(result.current.actionError).toContain('Cleanup is not confirmed.');
    expect([result.current.isStreaming, result.current.pendingApproval, result.current.isInterrupting]).toEqual([true, approval, false]);
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: false }) });
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: false }); });
    expect(result.current.actionError).toMatch(/cleanup.*confirm/i);
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: true }) });
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: true }); });
    expect([result.current.isStreaming, result.current.pendingApproval]).toEqual([true, approval]);
    act(() => {
      emit({ seq: 3, type: 'approval_resolved', approvalId: 'approval-stop', turnId: 'turn-stop', approved: false, reason: 'Cancelled' });
      emit({ seq: 4, type: 'turn_completed', turnId: 'turn-stop', status: 'cancelled' });
    });
    expect([result.current.isStreaming, result.current.pendingApproval]).toEqual([false, null]);
  });
  it('shows a recoverable interrupt network failure without retrying or claiming cancellation', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('Fixture network unavailable'));
    const { result } = renderSession('ss-v4-stop-network');
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: false }); });
    expect(result.current.actionError).toMatch(/stop.*confirm|interrupt.*confirm/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.isInterrupting).toBe(false);
  });
  it('retains cancellation retry after an unconfirmed interrupt even if the turn ended without a cleanup event', async () => {
    const { result } = renderSession('ss-stop-terminal-before-failure', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'turn_started', turnId: 'terminal-before-stop' }));
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending;
    act(() => { pending = result.current.interrupt(); });
    act(() => emit({ seq: 2, type: 'turn_completed', turnId: 'terminal-before-stop', status: 'failed' }));
    await act(async () => { resolve({ ok: false, status: 503, json: async () => ({ error: 'Cleanup receipt unavailable' }) }); await pending; });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.requiresCleanup).toBe(true);
    expect(result.current.actionError).toContain('Cleanup receipt unavailable');
  });
  it('does not restore an old cancellation failure after a newer canonical cleanup resolution', async () => {
    const { result } = renderSession('ss-stop-late-failure', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'error', code: 'v4_cleanup_pending', message: 'Prior cleanup failure' }));
    let reject;
    apiFetch.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let pending;
    act(() => { pending = result.current.interrupt(); });
    act(() => emit({ seq: 2, type: 'status', status: 'idle' }));
    await act(async () => { reject(new TypeError('Late lost HTTP receipt')); await pending; });
    expect(result.current.requiresCleanup).toBe(false);
    expect(result.current.actionError).toBe('');
  });
  it('ignores a delayed interrupt receipt after the session changes and aborts that request', async () => {
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook(({ sessionId }) => useStructuredSession({ sessionId, active: false, runtime: 'v4' }), { initialProps: { sessionId: 'ss-stop-before' } });
    let pending;
    act(() => { pending = result.current.interrupt(); });
    rerender({ sessionId: 'ss-stop-after' });
    await act(async () => { resolve({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: true }) }); expect(await pending).toMatchObject({ accepted: false, stale: true }); });
    expect(result.current.actionError).toBe('');
    expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it.each(['cleanup_required', 'reconciliation_required'])('recognizes a durable %s receipt without resending the accepted message', async status => {
    apiFetch.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(options.body.requestId, { status }) }));
    const { result } = renderSession();
    await act(async () => { expect(await result.current.sendMessage('Accepted before cleanup failure')).toMatchObject({ accepted: true, status }); });
    expect(result.current.messages).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it('retains cleanup retry and unresolved evidence after a failed turn until confirmed cleanup and canonical resolution', async () => {
    const { result } = renderSession('ss-v4-cleanup', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      [
        { type: 'turn_started', turnId: 'turn-cleanup' },
        { type: 'tool_started', turnId: 'turn-cleanup', toolCallId: 'tool-cleanup', toolName: 'run_command', toolInput: {} },
        { type: 'tool_output', turnId: 'turn-cleanup', toolCallId: 'tool-cleanup', output: 'Retain partial evidence' },
        { type: 'approval_required', turnId: 'turn-cleanup', approvalId: 'approval-cleanup', toolCallId: 'tool-cleanup', toolName: 'run_command' },
        { type: 'error', turnId: 'turn-cleanup', code: 'v4_cleanup_pending', message: 'Cleanup is not confirmed.' },
        { type: 'turn_completed', turnId: 'turn-cleanup', status: 'failed' },
      ].forEach((event, index) => emit({ seq: index + 1, ...event }));
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.requiresCleanup).toBe(true);
    expect(result.current.pendingApproval?.approvalId).toBe('approval-cleanup');
    expect(result.current.currentToolCalls[0].result).toBe('Retain partial evidence');
    apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Retry cleanup.' }) });
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: false }); });
    expect(result.current.requiresCleanup).toBe(true);
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: true }) });
    await act(async () => { expect(await result.current.interrupt()).toMatchObject({ accepted: true }); });
    expect(result.current.requiresCleanup).toBe(false);
    expect(result.current.pendingApproval?.approvalId).toBe('approval-cleanup');
    act(() => {
      emit({ seq: 7, type: 'approval_resolved', turnId: 'turn-cleanup', approvalId: 'approval-cleanup', approved: false });
      emit({ seq: 8, type: 'tool_completed', turnId: 'turn-cleanup', toolCallId: 'tool-cleanup', result: 'Cancelled after cleanup', isError: true });
      emit({ seq: 9, type: 'status', status: 'idle' });
    });
    expect(result.current.pendingApproval).toBeNull();
    expect(result.current.currentToolCalls).toEqual([]);
    expect(result.current.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', result: 'Cancelled after cleanup' })]));
  });
  it('uses authoritative snapshot status and sequence so historical errors cannot recreate a resolved cleanup blocker', async () => {
    const { result, rerender } = renderHook(({ sessionId, status, statusSeq }) => useStructuredSession({ sessionId, active: true, runtime: 'v4', status, statusSeq }), { initialProps: { sessionId: 'ss-cleanup-snapshot', status: 'idle', statusSeq: 2 } });
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'error', code: 'v4_cleanup_pending', message: 'Historical cleanup failure' });
      emit({ seq: 2, type: 'status', status: 'idle' });
      emit({ seq: 3, type: 'error', code: 'v4_cleanup_pending', message: 'Current cleanup failure' });
    });
    expect(result.current.requiresCleanup).toBe(true);
    rerender({ sessionId: 'ss-cleanup-snapshot', status: 'running', statusSeq: 2 });
    expect(result.current.requiresCleanup).toBe(true);
    act(() => emit({ seq: 4, type: 'status', status: 'idle' }));
    expect(result.current.requiresCleanup).toBe(false);
    rerender({ sessionId: 'ss-cleanup-other', status: 'reconciliation_required', statusSeq: 8 });
    expect(result.current.requiresCleanup).toBe(true);
    act(() => emit({ seq: 1, type: 'status', status: 'idle' }));
    expect(result.current.requiresCleanup).toBe(true);
    rerender({ sessionId: 'ss-cleanup-other', status: 'idle', statusSeq: 9 });
    expect(result.current.requiresCleanup).toBe(false);
    expect(result.current.messages).toEqual([]);
  });
  it('keeps a newer cleanup failure when an older successful cancellation receipt arrives late', async () => {
    const { result } = renderSession('ss-cleanup-late-receipt', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'error', code: 'v4_cleanup_pending', message: 'First cleanup' }));
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending;
    act(() => { pending = result.current.interrupt(); });
    act(() => {
      emit({ seq: 2, type: 'status', status: 'idle' });
      emit({ seq: 3, type: 'error', code: 'v4_cleanup_pending', message: 'Newer cleanup failure' });
    });
    await act(async () => { resolve({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: true }) }); await pending; });
    expect(result.current.requiresCleanup).toBe(true);
  });
  it('does not treat an ordinary clean provider failure as an unconfirmed cleanup', async () => {
    const { result } = renderSession('ss-clean-provider-failure', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'error', code: 'v4_turn_failed', message: 'Fixture provider failed' });
      emit({ seq: 2, type: 'turn_completed', turnId: 'turn-failed', status: 'failed' });
    });
    expect(result.current.requiresCleanup).toBe(false);
  });
  it('preserves legacy tool events without IDs and matches their output by the supplied tool name', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-legacy-idless', active: true }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'tool_started', toolName: 'First', toolInput: {} });
      emit({ seq: 2, type: 'tool_started', toolName: 'Second', toolInput: {} });
    });
    expect(result.current.currentToolCalls.map(tool => tool.toolName)).toEqual(['First', 'Second']);
    act(() => {
      emit({ seq: 3, type: 'tool_output', toolName: 'First', output: 'partial first' });
      emit({ seq: 4, type: 'tool_completed', toolName: 'First', result: 'first done', isError: false });
      emit({ seq: 5, type: 'tool_completed', toolName: 'Second', result: 'second done', isError: false });
    });
    expect(result.current.messages.map(message => [message.toolName, message.result])).toEqual([['First', 'first done'], ['Second', 'second done']]);
    expect(result.current.currentToolCalls).toEqual([]);
  });


  it('projects canonical compact controls without adding command or metrics bubbles', async () => {
    const { result } = renderSession('ss-compact-controls', true);
    await act(async () => { await Promise.resolve(); });
    const input = { instructions: 'Keep exact nullable input: \n😀', expectedRevision: 'a'.repeat(64), sourceRevision: 'a'.repeat(64) };
    const events = [
      { seq: 1, type: 'command_accepted', requestId: 'request-compact', turnId: 'turn-compact', command: 'compact', input },
      { seq: 2, type: 'turn_started', turnId: 'turn-compact' },
      { seq: 3, type: 'compaction', turnId: 'turn-compact', status: 'started' },
      { seq: 4, type: 'compaction', turnId: 'turn-compact', status: 'completed', receipt: { id: 'receipt-compact', beforeBytes: 1200, afterBytes: 1400 } },
      { seq: 5, type: 'context_usage', turnId: 'turn-compact', usage: { requestBytes: 1700, byteLimit: 2000 } },
      { seq: 6, type: 'turn_completed', turnId: 'turn-compact', status: 'completed' },
    ];
    act(() => events.forEach(emit));
    expect(result.current.controlState).toMatchObject({ sessionId: 'ss-compact-controls', latestSeq: 6, events, truncated: false });
    expect(result.current.messages).toEqual([]);
    expect(Socket.instances).toHaveLength(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('marks accepted compact busy until its matching canonical turn completes', async () => {
    const { result } = renderSession('ss-compact-busy', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'command_accepted', requestId: 'request-busy', turnId: 'compact-busy', command: 'compact', input: { instructions: null, expectedRevision: 'b'.repeat(64), sourceRevision: 'b'.repeat(64) } }));
    expect(result.current.isStreaming).toBe(true);
    act(() => emit({ seq: 2, type: 'turn_completed', turnId: 'unrelated', status: 'completed' }));
    expect(result.current.isStreaming).toBe(true);
    act(() => emit({ seq: 3, type: 'turn_completed', turnId: 'compact-busy', status: 'completed' }));
    expect(result.current.isStreaming).toBe(false);
  });
  it('keeps control replay ordered and deduplicated while tracking ordinary canonical sequence numbers', async () => {
    const { result } = renderSession('ss-compact-order', true);
    await act(async () => { await Promise.resolve(); });
    const command = { seq: 1, type: 'command_accepted', requestId: 'request-order', turnId: 'turn-order', command: 'compact', input: { instructions: null, expectedRevision: 'c'.repeat(64), sourceRevision: 'c'.repeat(64) } };
    act(() => {
      emit(command); emit(command);
      emit({ seq: 2, type: 'message_delta', role: 'assistant', messageId: 'answer-order', turnId: 'turn-order', content: 'Unchanged transcript identity' });
      emit({ seq: 3, type: 'compaction', turnId: 'turn-order', status: 'failed', message: 'Synthetic compaction failure' });
    });
    expect(result.current.controlState.latestSeq).toBe(3);
    expect(result.current.controlState.events.map(event => event.seq)).toEqual([1, 3]);
    expect(result.current.messages).toEqual([expect.objectContaining({ messageId: 'answer-order', content: 'Unchanged transcript identity' })]);
    expect(Socket.instances).toHaveLength(1);
  });
  it('bounds control history by count and preserves exact canonical nullable input', async () => {
    const { result } = renderSession('ss-compact-count', true);
    await act(async () => { await Promise.resolve(); });
    const input = { instructions: null, expectedRevision: 'd'.repeat(64), sourceRevision: 'd'.repeat(64) };
    act(() => { for (let index = 1; index <= 80; index += 1) emit({ seq: index, type: 'command_accepted', requestId: `request-count-${index}`, turnId: `turn-count-${index}`, command: 'compact', input }); });
    expect(result.current.controlState).toMatchObject({ latestSeq: 80, truncated: true });
    expect(result.current.controlState.events).toHaveLength(64);
    expect(result.current.controlState.events[0].seq).toBe(17);
    expect(result.current.controlState.events.at(-1).input).toEqual(input);
  });
  it('bounds controls by UTF8 bytes without truncating an exact command body', async () => {
    const { result } = renderSession('ss-compact-bytes', true);
    await act(async () => { await Promise.resolve(); });
    const input = { instructions: '😀'.repeat(4000), expectedRevision: 'e'.repeat(64), sourceRevision: 'e'.repeat(64) };
    act(() => { for (let index = 1; index <= 30; index += 1) emit({ seq: index, type: 'command_accepted', requestId: `request-bytes-${index}`, turnId: `turn-bytes-${index}`, command: 'compact', input }); });
    const projected = result.current.controlState;
    expect(projected.truncated).toBe(true);
    expect(projected.events.length).toBeLessThan(30);
    expect(projected.events.length).toBeGreaterThan(0);
    expect(projected.events.reduce((bytes, event) => bytes + new TextEncoder().encode(JSON.stringify(event)).length, 0)).toBeLessThanOrEqual(256000);
    expect(projected.events.every(event => event.input.instructions === input.instructions)).toBe(true);
    act(() => emit({ seq: 31, type: 'compaction', turnId: 'oversized', status: 'failed', message: 'x'.repeat(64001) }));
    expect(result.current.controlState.latestSeq).toBe(31);
    expect(result.current.controlState.events.some(event => event.turnId === 'oversized')).toBe(false);
  });
  it.each(['sequence gap', 'events_lost'])('clears controls and advances recovery generation after %s without a second live socket', async reset => {
    vi.useFakeTimers();
    try {
      const { result } = renderSession('ss-compact-gap-' + reset, true);
      await act(async () => { await Promise.resolve(); });
      const oldSocket = Socket.instances.at(-1), late = oldSocket.onmessage;
      act(() => emit({ seq: 1, type: 'compaction', turnId: 'old-turn', status: 'started' }));
      const generation = result.current.controlState.generation;
      act(() => reset === 'sequence gap'
        ? emit({ seq: 3, type: 'compaction', turnId: 'gapped-turn', status: 'completed' })
        : oldSocket.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'events_lost' }) }));
      expect(result.current.controlState.events).toEqual([]);
      expect(result.current.controlState.latestSeq).toBe(0);
      expect(result.current.controlState.generation).toBeGreaterThan(generation);
      await act(async () => { vi.advanceTimersByTime(1500); await Promise.resolve(); });
      expect(Socket.instances.filter(socket => !socket.closed)).toHaveLength(1);
      expect(Socket.instances).toHaveLength(2);
      expect(Socket.instances.at(-1).url).not.toContain('last_seq=');
      act(() => late({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 2, type: 'compaction', turnId: 'late-old-turn', status: 'completed' } }) }));
      expect(result.current.controlState.events).toEqual([]);
      expect(apiFetch).not.toHaveBeenCalled(); // The dialog owns read-only snapshot/UUID recovery.
    } finally { vi.useRealTimers(); }
  });
  it('never projects old controls during actual hook session ABA or late socket callbacks', async () => {
    const renders = [];
    const view = renderHook(({ id }) => {
      const state = useStructuredSession({ sessionId: id, active: true, runtime: 'v4' });
      renders.push({ id, controls: state.controlState }); return state;
    }, { initialProps: { id: 'ss-control-a' } });
    await act(async () => { await Promise.resolve(); });
    const oldSocket = Socket.instances.at(-1), late = oldSocket.onmessage;
    act(() => emit({ seq: 1, type: 'compaction', turnId: 'old-a-turn', status: 'started' }));
    const generation = view.result.current.controlState.generation;
    view.rerender({ id: 'ss-control-b' });
    expect(renders.filter(value => value.id === 'ss-control-b').every(value => value.controls?.sessionId === 'ss-control-b' && value.controls.events.length === 0)).toBe(true);
    view.rerender({ id: 'ss-control-a' });
    act(() => late({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 2, type: 'compaction', turnId: 'old-a-late', status: 'completed' } }) }));
    expect(view.result.current.controlState).toMatchObject({ sessionId: 'ss-control-a', latestSeq: 0, events: [] });
    expect(view.result.current.controlState.generation).toBeGreaterThan(generation);
  });
  it.each(['account', 'full home API', 'environment'])('isolates compact controls and late callbacks across %s changes', async change => {
    act(() => setEnvironmentIdentity('control-owner-a', 'https://fixture.invalid/full-home-a/api'));
    const view = renderSession('ss-control-scope', true);
    try {
      await act(async () => { await Promise.resolve(); });
      const oldSocket = Socket.instances.at(-1), late = oldSocket.onmessage;
      act(() => emit({ seq: 1, type: 'compaction', turnId: 'old-scope', status: 'started' }));
      const generation = view.result.current.controlState.generation;
      await act(async () => {
        if (change === 'account') setEnvironmentIdentity('control-owner-b', 'https://fixture.invalid/full-home-a/api');
        else if (change === 'full home API') setEnvironmentIdentity('control-owner-a', 'https://fixture.invalid/full-home-b/api');
        else setActiveEnvironment({ id: 'control-other-host', capabilities: { agentExecute: true } });
        await Promise.resolve();
      });
      act(() => late({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 2, type: 'compaction', turnId: 'late-old-scope', status: 'completed' } }) }));
      expect(view.result.current.controlState).toMatchObject({ sessionId: 'ss-control-scope', latestSeq: 0, events: [] });
      expect(view.result.current.controlState.generation).toBeGreaterThan(generation);
      expect(Socket.instances).toHaveLength(2);
      expect(Socket.instances.filter(socket => !socket.closed)).toHaveLength(1);
      expect(apiFetch).not.toHaveBeenCalled();
    } finally { view.unmount(); act(() => setEnvironmentIdentity('')); }
  });
  it('does not retain context usage across environment changes for the same session', async () => {
    const view = renderSession('ss-context-scope', true);
    await act(async () => { await Promise.resolve(); });
    const late = Socket.instances.at(-1).onmessage;
    act(() => emit({ seq: 1, type: 'context_usage', usage: { requestBytes: 123 } }));
    expect(view.result.current.contextUsage).toEqual({ requestBytes: 123 });
    await act(async () => {
      setActiveEnvironment({ id: 'other-context-host', capabilities: { agentExecute: true } });
      await Promise.resolve();
    });
    act(() => late({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 2, type: 'context_usage', usage: { requestBytes: 456 } } }) }));
    expect(view.result.current.contextUsage).toBeNull();
    act(() => emit({ seq: 1, type: 'context_usage', usage: { requestBytes: 789 } }));
    expect(view.result.current.contextUsage).toEqual({ requestBytes: 789 });
    await act(async () => { setActiveEnvironment(null); await Promise.resolve(); });
    expect(view.result.current.contextUsage).toBeNull();
    view.unmount();
  });
  it('clears the context reading when an event gap requires a history reset', async () => {
    const view = renderSession('ss-context-gap', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'context_usage', usage: { requestBytes: 123 } }));
    expect(view.result.current.contextUsage).toEqual({ requestBytes: 123 });
    act(() => Socket.instances.at(-1).onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'events_lost' }) }));
    expect(view.result.current.contextUsage).toBeNull();
    view.unmount();
  });
  it('does not project owned controls for optional legacy structured providers', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-legacy-control', active: true }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'compaction', turnId: 'legacy-ignored', status: 'started' }));
    expect(result.current.controlState).toMatchObject({ latestSeq: 0, events: [] });
  });
  it('exports Stop failure separately and never relaxes ordinary message receipt identity for compaction', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Synthetic cleanup pending' }) });
    const { result } = renderSession('ss-control-stop');
    await act(async () => { await result.current.interrupt(); });
    expect(result.current.controlError).toMatch(/cleanup pending/);
    expect(result.current.actionError).toMatch(/cleanup pending/);
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST'
      ? { ok: true, json: async () => ({ status: 'accepted', requestId: options.body.requestId, turnId: 'compact-not-message', acceptedSeq: 1 }) }
      : { ok: false, status: 404 });
    const clean = renderSession('ss-control-strict-message');
    await act(async () => { await expect(clean.result.current.sendMessage('Keep strict ordinary message receipt')).rejects.toThrow(/confirm/i); });
    expect(clean.result.current.messages).toEqual([]);
  });


  it('returns only reconciled session health when a late Stop failure follows canonical idle', async () => {
    const { result } = renderSession('ss-compact-stop-reconciled', true);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'error', code: 'v4_cleanup_pending', message: 'Synthetic cleanup pending' }));
    let reject;
    apiFetch.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let pending;
    act(() => { pending = result.current.interrupt(); });
    act(() => emit({ seq: 2, type: 'status', status: 'idle' }));
    let response;
    await act(async () => { reject(new TypeError('Late lost Stop response')); response = await pending; });
    expect(response).toEqual({ accepted: true, reconciled: true });
    expect(response.cleanupConfirmed).toBeUndefined();
    expect(response.status).toBeUndefined();
    expect(result.current.requiresCleanup).toBe(false);
    expect(result.current.messages.filter(message => message.role === 'user')).toEqual([]);
  });


  it('advances the context authority sequence for omitted canonical kinds after the last usage event', async () => {
    const { result } = renderSession('ss-context-latest-omitted', true);
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'context_usage', turnId: 'usage-turn', usage: { requestBytes: 700, byteLimit: 2000 } });
      emit({ seq: 2, type: 'message_completed', role: 'assistant', messageId: 'answer-omitted', turnId: 'ordinary-turn', content: 'A later canonical answer' });
      emit({ seq: 3, type: 'status', status: 'idle' });
      emit({ seq: 4, type: 'tool_started', toolCallId: 'tool-omitted', turnId: 'ordinary-turn', toolName: 'read_file', toolInput: { path: 'synthetic.txt' } });
    });
    expect(result.current.controlState.latestSeq).toBe(4);
    expect(result.current.controlState.events.map(event => [event.type, event.seq])).toEqual([['context_usage', 1]]);
  });


  it('bounds the complete encoded control array including brackets and commas at the per-event limit', async () => {
    const { result } = renderSession('ss-control-array-boundary', true);
    await act(async () => { await Promise.resolve(); });
    const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;
    const events = Array.from({ length: 4 }, (_, index) => {
      const event = { type: 'compaction', seq: index + 1, turnId: `boundary-turn-${index + 1}`, status: 'failed', message: '😀' };
      event.message += 'x'.repeat(64000 - byteLength(event));
      return event;
    });
    expect(events.map(byteLength)).toEqual([64000, 64000, 64000, 64000]);
    expect(byteLength(events)).toBe(256005);
    act(() => events.forEach(emit));
    const projected = result.current.controlState;
    expect(byteLength(projected.events)).toBeLessThanOrEqual(256000);
    expect(projected.events.length).toBeLessThanOrEqual(64);
    expect(projected.events.every(event => byteLength(event) <= 64000)).toBe(true);
    expect(projected.events).toEqual(events.slice(1));
    expect(projected.truncated).toBe(true);
    expect(projected.latestSeq).toBe(4);
  });

});
