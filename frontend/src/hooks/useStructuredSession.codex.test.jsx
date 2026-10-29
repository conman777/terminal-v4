import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnvironmentStorage, setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'fixture-token', isAccessTokenExpired: () => false, refreshTokens: vi.fn(), captureAuthScope: () => ({ userId: 'codex-fixture', home: window.location.origin, session: 'fixture' }), isAuthScopeCurrent: () => true, subscribeAuth: () => () => {} }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
vi.mock('../utils/supervisedInputTransaction', () => ({ supervisedInputTransaction: vi.fn(callback => Promise.resolve().then(callback)) }));
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
import { supervisedInputTransaction } from '../utils/supervisedInputTransaction';

class Socket {
  static instances = [];
  constructor() { Socket.instances.push(this); }
  close() { this.onclose?.({ code: 1000 }); }
}
const originalSocket = globalThis.WebSocket;
const receipt = requestId => ({ status: 'accepted', requestId, turnId: 'codex-turn', messageId: 'codex-user', acceptedSeq: 1 });
const reservation = approvalId => ({ ok: true, json: async () => ({ approvalId, reservationId: 'reservation-one', deliveryToken: 'private-token', status: 'reserved' }) });
const capability = (mode = 'reservation', outstanding = false) => ({ ok: true, json: async () => ({ protocol: 1, mode, outstanding }) });
const emit = event => Socket.instances.at(-1).onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });

describe('local Codex conversation', () => {
  beforeEach(() => { localStorage.clear(); setEnvironmentIdentity('codex-fixture'); setActiveEnvironment(null); apiFetch.mockReset(); supervisedInputTransaction.mockReset().mockImplementation(callback => Promise.resolve().then(callback)); Socket.instances = []; globalThis.WebSocket = Socket; });
  afterEach(() => { setEnvironmentIdentity(null); globalThis.WebSocket = originalSocket; });

  it('uses a durable send identity and merges its live acceptance without repeating the user message', async () => {
    apiFetch.mockImplementation(async (_url, options) => {
      emit({ type: 'user_message_accepted', seq: 1, ...receipt(options.body.requestId), content: 'Inspect this project' });
      return { ok: true, json: async () => receipt(options.body.requestId) };
    });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-send', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.sendMessage('Inspect this project'); });
    expect(apiFetch.mock.calls[0][1].body).toEqual({ text: 'Inspect this project\n', fallbackToMessage: true, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(result.current.messages).toEqual([expect.objectContaining({ role: 'user', content: 'Inspect this project', messageId: 'codex-user' })]);
  });

  it('binds an approval to the displayed action and keeps it held until durable resolution', async () => {
    let resolve;
    apiFetch.mockImplementation(url => url.endsWith('/approval-capability') ? Promise.resolve(capability()) : url.endsWith('/reserve') ? Promise.resolve(reservation('action-one')) : new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-one', turnId: 'turn', toolName: 'run_command', description: 'Run tests' }));
    let approval;
    act(() => { approval = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(apiFetch.mock.calls[2][1].body).toEqual({ approved: true, approvalId: 'action-one', reservationId: 'reservation-one', reservationToken: 'private-token' }));
    act(() => emit({ seq: 2, type: 'approval_required', approvalId: 'action-two', turnId: 'turn', toolName: 'edit_files', description: 'Edit files' }));
    await act(async () => { resolve({ ok: true, json: async () => ({ status: 'accepted', approvalId: 'action-one', approved: true }) }); await approval; });
    expect(result.current.pendingApproval).toEqual(expect.objectContaining({ approvalId: 'action-one', decisionUnconfirmed: true }));
    act(() => emit({ seq: 3, type: 'approval_resolved', approvalId: 'action-one', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toBeNull();
  });

  it('retains an uncertain started decision and refuses to resend it after reconnect replay', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-uncertain-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'action-one', turnId: 'turn', toolName: 'run_command', description: 'Run tests' });
      emit({ seq: 2, type: 'approval_decision_started', approvalId: 'action-one', turnId: 'turn', approved: true, forSession: false });
    });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-one', decisionUncertain: true, approved: true });
    act(() => emit({ seq: 3, type: 'turn_completed', turnId: 'turn', status: 'interrupted' }));
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-one', decisionUncertain: true });
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
    act(() => emit({ seq: 4, type: 'approval_resolved', approvalId: 'action-one', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toBeNull();
  });

  it('acknowledges an uncertain approval through its exact review endpoint without resending', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-review', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'action-one', turnId: 'turn', toolName: 'run_command' });
      emit({ seq: 2, type: 'approval_decision_started', approvalId: 'action-one', turnId: 'turn', approved: false });
      emit({ seq: 3, type: 'turn_completed', turnId: 'turn', status: 'interrupted' });
    });
    apiFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Stop the session first.' }) });
    await act(async () => { expect(await result.current.reviewApproval(result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-one', decisionUncertain: true });
    expect(result.current.actionError).toContain('Stop the session');
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ approvalId: 'action-one', status: 'reviewed' }) });
    await act(async () => { expect(await result.current.reviewApproval(result.current.pendingApproval)).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/structured/sessions/ss-codex-review/approval-claims/action-one/review',
      '/api/structured/sessions/ss-codex-review/approval-claims/action-one/review',
    ]);
    expect(result.current.pendingApproval).toBeNull();
  });

  it('keeps an uncertain approval and explains when this server cannot review it', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-review-unavailable', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'action-one', turnId: 'turn', toolName: 'run_command' });
      emit({ seq: 2, type: 'approval_decision_started', approvalId: 'action-one', turnId: 'turn', approved: true });
    });
    apiFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await act(async () => { expect(await result.current.reviewApproval(result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-one', decisionUncertain: true, reviewUnavailable: true });
    expect(result.current.actionError).toMatch(/cannot safely acknowledge/i);
  });

  it('blocks another decision when the response is lost before the started event arrives', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-lost-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-lost', turnId: 'turn', toolName: 'run_command' }));
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce(reservation('action-lost')).mockRejectedValueOnce(new TypeError('Synthetic response lost'));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-lost', decisionUnconfirmed: true });
    await act(async () => { expect(await result.current.approve(false, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    act(() => emit({ seq: 2, type: 'approval_decision_started', approvalId: 'action-lost', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toMatchObject({ decisionUncertain: true, decisionUnconfirmed: false });
  });

  it('restores an in-flight approval intent after remount without persisting its decision', async () => {
    apiFetch.mockImplementation(url => url.endsWith('/approval-capability') ? Promise.resolve(capability()) : new Promise(() => {}));
    const first = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-remount', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-remount', turnId: 'turn', toolName: 'run_command' }));
    act(() => { void first.result.current.approve(true, first.result.current.pendingApproval); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const keys = Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'));
    expect(keys).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(keys[0]))).toEqual({ version: 1, sessionId: 'ss-codex-remount', approvalId: 'action-remount', intentId: expect.any(String) });
    first.unmount();
    const second = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-remount', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-remount', turnId: 'turn', toolName: 'run_command' }));
    expect(second.result.current.pendingApproval).toMatchObject({ approvalId: 'action-remount', decisionUnconfirmed: true });
    await act(async () => { expect(await second.result.current.approve(false, second.result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('disables a displayed approval when another tab persists its intent', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-other-tab', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-shared', turnId: 'turn', toolName: 'run_command' }));
    const key = 'approvalDecision:v1:ss-codex-other-tab';
    getEnvironmentStorage().setItem(key, JSON.stringify({ version: 1, sessionId: 'ss-codex-other-tab', approvalId: 'action-shared' }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: `scope:${key}` })));
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-shared', decisionUnconfirmed: true });
    await act(async () => { expect(await result.current.approve(false, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('can settle an unconfirmed decision after the provider has stopped without resending', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-unconfirmed-review', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-unknown', turnId: 'turn', toolName: 'run_command' }));
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce(reservation('action-unknown')).mockRejectedValueOnce(new TypeError('Synthetic response lost'));
    await act(async () => { await result.current.approve(true, result.current.pendingApproval); });
    act(() => emit({ seq: 2, type: 'turn_completed', turnId: 'turn', status: 'interrupted' }));
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ approvalId: 'action-unknown', status: 'reviewed' }) });
    await act(async () => { expect(await result.current.reviewApproval(result.current.pendingApproval)).toMatchObject({ accepted: true }); });
    expect(result.current.pendingApproval).toBeNull();
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/structured/sessions/ss-codex-unconfirmed-review/approval-capability',
      '/api/structured/sessions/ss-codex-unconfirmed-review/approval-claims/action-unknown/reserve',
      '/api/structured/sessions/ss-codex-unconfirmed-review/approve',
      '/api/structured/sessions/ss-codex-unconfirmed-review/approval-claims/action-unknown/review',
    ]);
  });

  it('keeps a successful HTTP decision until its durable resolution event arrives', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-http-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-http', turnId: 'turn', toolName: 'run_command' }));
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce(reservation('action-http')).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'accepted', approvalId: 'action-http', approved: true }) });
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: true }); });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-http', decisionUnconfirmed: true });
    act(() => emit({ seq: 2, type: 'approval_decision_started', approvalId: 'action-http', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toMatchObject({ decisionUncertain: true });
    act(() => emit({ seq: 3, type: 'approval_resolved', approvalId: 'action-http', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toBeNull();
  });

  it('reserves the exact approval and keeps the one-time token out of browser storage', async () => {
    apiFetch.mockImplementation(async url => url.endsWith('/approval-capability') ? capability() : url.endsWith('/reserve')
      ? { ok: true, json: async () => ({ approvalId: 'action-reserve', reservationId: 'reservation-one', deliveryToken: 'private-token', status: 'reserved' }) }
      : { ok: true, json: async () => ({ status: 'accepted', approvalId: 'action-reserve', approved: true }) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-reserve', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-reserve', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      ['/api/structured/sessions/ss-codex-reserve/approval-capability', undefined],
      ['/api/structured/sessions/ss-codex-reserve/approval-claims/action-reserve/reserve', undefined],
      ['/api/structured/sessions/ss-codex-reserve/approve', { approved: true, approvalId: 'action-reserve', reservationId: 'reservation-one', reservationToken: 'private-token' }],
    ]);
    expect(JSON.stringify(Object.values(localStorage))).not.toContain('private-token');
  });

  it('does not dispatch an unreserved decision when the reserve route is unavailable', async () => {
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-old-server', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-old', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-codex-old-server/approval-capability', '/api/structured/sessions/ss-codex-old-server/approval-claims/action-old/reserve']);
    expect(result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true });
  });

  it('shows a reservation from another client without allowing a decision', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-reserved', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'action-reserved', turnId: 'turn', toolName: 'run_command' });
      emit({ seq: 2, type: 'approval_decision_reserved', approvalId: 'action-reserved', turnId: 'turn', reservationId: 'reservation-other', tokenHash: 'hash' });
    });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'action-reserved', decisionUnconfirmed: true });
    await act(async () => { expect(await result.current.approve(false, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('uses legacy approval only when the session explicitly attests that mode', async () => {
    apiFetch.mockResolvedValueOnce(capability('legacy')).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'accepted', approvalId: 'action-legacy', approved: true }) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-legacy-mode', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-legacy', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-codex-legacy-mode/approval-capability', '/api/structured/sessions/ss-codex-legacy-mode/approve']);
    expect(apiFetch.mock.calls[1][1].body).toEqual({ approvalId: 'action-legacy', approved: true });
    expect(result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true, reviewUnavailable: true });
  });

  it('retains legacy recovery guidance after a lost response and remount', async () => {
    apiFetch.mockResolvedValueOnce(capability('legacy')).mockRejectedValueOnce(new TypeError('Synthetic response lost'));
    const first = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-legacy-reload', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-legacy', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await first.result.current.approve(true, first.result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(first.result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true, reviewUnavailable: true });
    first.unmount();
    const second = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-legacy-reload', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-legacy', turnId: 'turn', toolName: 'run_command' }));
    expect(second.result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true, reviewUnavailable: true });
    await act(async () => { expect(await second.result.current.reviewApproval(second.result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('never infers legacy mode from an unavailable capability', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-unknown-mode', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-unknown', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-codex-unknown-mode/approval-capability']);
  });

  it.each(['Session is busy; try again', 'Approval supervisor is at capacity; try again'])('clears its local intent after typed pre-write rejection: %s', async message => {
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ status: 'not_started', error: message }) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-busy', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-busy', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).not.toHaveProperty('decisionUnconfirmed');
    expect(result.current.actionError).toContain(message);
    expect(Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'))).toHaveLength(0);
  });

  it('keeps a server-reported outstanding reservation held without dispatching', async () => {
    apiFetch.mockResolvedValueOnce(capability('reservation', true));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-held', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-held', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-codex-held/approval-capability']);
  });

  it('retains the identity after an ambiguous reservation failure', async () => {
    apiFetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Unavailable' }) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-ambiguous', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-ambiguous', turnId: 'turn', toolName: 'run_command' }));
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(result.current.pendingApproval).toMatchObject({ decisionUnconfirmed: true });
    expect(Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'))).toHaveLength(1);
  });

  it('does not dispatch a reserved decision after a resolution arrives during reservation', async () => {
    let finishReservation;
    apiFetch.mockImplementation(url => url.endsWith('/approval-capability') ? Promise.resolve(capability()) : new Promise(resolve => { finishReservation = resolve; }));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-resolve-race', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-race', turnId: 'turn', toolName: 'run_command' }));
    let decision;
    act(() => { decision = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(finishReservation).toBeTypeOf('function'));
    await act(async () => { emit({ seq: 2, type: 'approval_resolved', approvalId: 'action-race', turnId: 'turn', approved: false }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { finishReservation(reservation('action-race')); expect(await decision).toMatchObject({ accepted: false, stale: true }); });
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/structured/sessions/ss-codex-resolve-race/approval-capability', '/api/structured/sessions/ss-codex-resolve-race/approval-claims/action-race/reserve']);
  });

  it('does not write an intent when resolution arrives during the capability check', async () => {
    let finishCapability;
    apiFetch.mockImplementation(() => new Promise(resolve => { finishCapability = resolve; }));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-cap-race', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-race', turnId: 'turn', toolName: 'run_command' }));
    let decision;
    act(() => { decision = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(finishCapability).toBeTypeOf('function'));
    act(() => emit({ seq: 2, type: 'approval_resolved', approvalId: 'action-race', turnId: 'turn', approved: false }));
    await act(async () => { finishCapability(capability()); expect(await decision).toMatchObject({ accepted: false, stale: true }); });
    expect(Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'))).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('clears an intent that finishes saving after authoritative resolution', async () => {
    let finishSave;
    supervisedInputTransaction.mockImplementationOnce(callback => new Promise(resolve => { finishSave = () => resolve(callback()); }));
    apiFetch.mockResolvedValueOnce(capability());
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-storage-race', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-race', turnId: 'turn', toolName: 'run_command' }));
    let decision;
    act(() => { decision = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(finishSave).toBeTypeOf('function'));
    await act(async () => { emit({ seq: 2, type: 'approval_resolved', approvalId: 'action-race', turnId: 'turn', approved: false }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { finishSave(); expect(await decision).toMatchObject({ accepted: false, stale: true }); });
    expect(Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'))).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('removes only its undispatched intent when scope changes during storage', async () => {
    let finishSave;
    supervisedInputTransaction.mockImplementationOnce(callback => new Promise(resolve => { const saved = callback(); finishSave = () => resolve(saved); }));
    apiFetch.mockResolvedValueOnce(capability());
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-scope-race', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-race', turnId: 'turn', toolName: 'run_command' }));
    let decision;
    act(() => { decision = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(finishSave).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'new-environment' }));
    await act(async () => { finishSave(); expect(await decision).toMatchObject({ accepted: false, stale: true }); });
    expect(Object.keys(localStorage).filter(key => key.includes('approvalDecision:v1:'))).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('dispatches only its own reservation after its broadcast arrives', async () => {
    let finishReservation;
    apiFetch.mockImplementation(url => url.endsWith('/approval-capability') ? Promise.resolve(capability()) : url.endsWith('/reserve') ? new Promise(resolve => { finishReservation = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ status: 'accepted', approvalId: 'action-own', approved: true }) }));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-own-reservation', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_required', approvalId: 'action-own', turnId: 'turn', toolName: 'run_command' }));
    let decision;
    act(() => { decision = result.current.approve(true, result.current.pendingApproval); });
    await waitFor(() => expect(finishReservation).toBeTypeOf('function'));
    act(() => emit({ seq: 2, type: 'approval_decision_reserved', approvalId: 'action-own', turnId: 'turn', reservationId: 'reservation-one', tokenHash: 'hash' }));
    await act(async () => { finishReservation(reservation('action-own')); expect(await decision).toMatchObject({ accepted: true }); });
    expect(apiFetch.mock.calls[2][1].body).toMatchObject({ reservationId: 'reservation-one', reservationToken: 'private-token' });
  });

  it('recognizes a legacy started decision with an empty turn ID', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-legacy-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      emit({ seq: 1, type: 'approval_required', approvalId: 'legacy-action', toolName: 'run_command' });
      emit({ seq: 2, type: 'approval_decision_started', approvalId: 'legacy-action', turnId: '', approved: true });
    });
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'legacy-action', decisionUncertain: true });
  });

  it('keeps an unmatched started claim visible for review without inventing action details', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-missing-approval', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ seq: 1, type: 'approval_decision_started', approvalId: 'missing-action', turnId: 'turn', approved: true }));
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'missing-action', turnId: 'turn', decisionUncertain: true, toolName: 'Unknown action' });
    act(() => emit({ seq: 2, type: 'approval_required', approvalId: 'missing-action', turnId: 'turn', toolName: 'run_command', description: 'Recovered details' }));
    expect(result.current.pendingApproval).toMatchObject({ approvalId: 'missing-action', decisionUncertain: true, description: 'Recovered details' });
    await act(async () => { expect(await result.current.approve(true, result.current.pendingApproval)).toMatchObject({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('keeps Stop available when cleanup is not confirmed', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'cancelled', cleanupConfirmed: false }) });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-stop', active: false, runtime: 'codex' }));
    await act(async () => { expect(await result.current.interrupt()).toEqual({ accepted: false }); });
    expect(result.current.requiresCleanup).toBe(true);
    expect(result.current.actionError).toMatch(/cleanup.*confirmed/i);
  });

  it('makes Stop available as soon as the message is accepted during Codex startup', async () => {
    apiFetch.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(options.body.requestId) }));
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-startup', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.sendMessage('Inspect'); });
    expect(result.current.isStreaming).toBe(true);
    act(() => emit({ type: 'turn_completed', seq: 2, turnId: 'codex-turn', status: 'interrupted' }));
    expect(result.current.isStreaming).toBe(false);
  });

  it('does not restart the running indicator when a send receipt arrives after its completed turn', async () => {
    apiFetch.mockImplementation(async (_url, options) => {
      emit({ type: 'user_message_accepted', seq: 1, ...receipt(options.body.requestId), content: 'Inspect' });
      emit({ type: 'turn_completed', seq: 2, turnId: 'codex-turn', status: 'completed' });
      return { ok: true, json: async () => receipt(options.body.requestId) };
    });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-late-receipt', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.sendMessage('Inspect'); });
    expect(result.current.isStreaming).toBe(false);
  });
  it('streams reasoning summaries and keeps one up-to-date plan per turn', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-codex-work', active: true, runtime: 'codex' }));
    await act(async () => { await Promise.resolve(); });
    const plan = steps => JSON.stringify({ explanation: null, steps });
    act(() => {
      emit({ seq: 1, type: 'user_message_accepted', requestId: 'r', turnId: 'turn', messageId: 'ask', content: 'Fix it' });
      emit({ seq: 2, type: 'message_delta', role: 'reasoning', messageId: 'r1', turnId: 'turn', content: 'Reading ' });
      emit({ seq: 3, type: 'message_delta', role: 'reasoning', messageId: 'r1', turnId: 'turn', content: 'the layout' });
      emit({ seq: 4, type: 'message_completed', role: 'plan', messageId: 'plan-turn', turnId: 'turn', content: plan([{ step: 'Fix CSS', status: 'inProgress' }]) });
    });
    expect(result.current.messages.map(({ role, content, streaming }) => ({ role, content, streaming }))).toEqual([
      { role: 'user', content: 'Fix it', streaming: undefined },
      { role: 'reasoning', content: 'Reading the layout', streaming: true },
      { role: 'plan', content: plan([{ step: 'Fix CSS', status: 'inProgress' }]), streaming: false },
    ]);
    act(() => {
      emit({ seq: 5, type: 'message_completed', role: 'plan', messageId: 'plan-turn', turnId: 'turn', content: plan([{ step: 'Fix CSS', status: 'completed' }]) });
      emit({ seq: 6, type: 'turn_completed', turnId: 'turn', status: 'completed' });
    });
    expect(result.current.messages.slice(1).map(({ role, content, streaming }) => ({ role, content, streaming }))).toEqual([
      { role: 'reasoning', content: 'Reading the layout', streaming: false },
      { role: 'plan', content: plan([{ step: 'Fix CSS', status: 'completed' }]), streaming: false },
    ]);
  });
});
