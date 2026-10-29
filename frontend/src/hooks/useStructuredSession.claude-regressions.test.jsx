import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'fixture-token', isAccessTokenExpired: () => false, refreshTokens: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
class Socket {
  static instances = [];
  constructor() { Socket.instances.push(this); }
  close() { this.onclose?.({ code: 1000 }); }
}
const originalSocket = globalThis.WebSocket;
const emit = event => Socket.instances.at(-1).onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
const canonical = (id) => ({ type:'message_completed',role:'user',content:'Inspect',messageId:id,seq:Number(id.split('-').at(-1)) });
describe('legacy Claude durable history', () => {
  beforeEach(() => { setActiveEnvironment(null); apiFetch.mockReset(); Socket.instances = []; globalThis.WebSocket = Socket; });
  afterEach(() => { globalThis.WebSocket = originalSocket; });
  it.each(['before','after'])('merges canonical question when WS arrives %s the response', async order => {
    apiFetch.mockImplementation(async () => {
      if(order === 'before') emit(canonical('question-1'));
      return {ok:true};
    });
    const {result} = renderHook(() => useStructuredSession({sessionId:'ss-claude-'+order,active:true,runtime:'claude'}));
    await act(async () => {await Promise.resolve();});
    await act(async () => {await result.current.sendMessage('Inspect');});
    if(order === 'after') act(() => emit(canonical('question-1')));
    expect(result.current.messages).toEqual([expect.objectContaining({role:'user',content:'Inspect',messageId:'question-1'})]);
  });
  it('keeps identical questions from separate sends',async () => {
    let count=0;
    apiFetch.mockImplementation(async () => {emit(canonical('question-'+(++count)));return {ok:true};});
    const {result}=renderHook(() => useStructuredSession({sessionId:'ss-repeated',active:true,runtime:'claude'}));
    await act(async () => {await Promise.resolve();});
    await act(async () => {await result.current.sendMessage('Inspect');});
    await act(async () => {await result.current.sendMessage('Inspect');});
    expect(result.current.messages.map(message=>message.messageId)).toEqual(['question-1','question-2']);
  });
  it('does not merge a new send into an identical historical question and restores canonical history after remount', async () => {
    apiFetch.mockImplementation(async () => {emit(canonical('question-2'));return {ok:true};});
    const first=renderHook(() => useStructuredSession({sessionId:'ss-reload',active:true,runtime:'claude'}));
    await act(async () => {await Promise.resolve();});
    act(() => emit(canonical('question-1')));
    await act(async () => {await first.result.current.sendMessage('Inspect');});
    expect(first.result.current.messages.map(message=>message.messageId)).toEqual(['question-1','question-2']);
    first.unmount();
    const second=renderHook(() => useStructuredSession({sessionId:'ss-reload',active:true,runtime:'claude'}));
    await act(async () => {await Promise.resolve();});
    act(() => {emit(canonical('question-1'));emit(canonical('question-2'));});
    expect(second.result.current.messages.map(message=>message.messageId)).toEqual(['question-1','question-2']);
  });
  it('keeps accepted canonical history when process launch reports failure', async () => {
    apiFetch.mockImplementation(async () => {emit(canonical('question-1'));return {ok:false,status:409,json:async()=>({error:'Could not start Claude'})};});
    const {result}=renderHook(() => useStructuredSession({sessionId:'ss-failed',active:true,runtime:'claude'}));
    await act(async () => {await Promise.resolve();});
    await act(async () => {await expect(result.current.sendMessage('Inspect')).rejects.toThrow('Could not start Claude');});
    expect(result.current.messages).toEqual([expect.objectContaining({messageId:'question-1',content:'Inspect'})]);
    expect(result.current.actionError).toContain('Could not start Claude');
  });

  it('keeps the legacy turn active across pre-tool and final message completion until session end', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-tool-turn', runtime: 'claude' }));
    await act(async () => { await Promise.resolve(); });
    const events = [
      { type: 'session_started', sessionId: 'ss-tool-turn', provider: 'claude' },
      { type: 'message_delta', role: 'assistant', content: 'Before.' },
      { type: 'message_completed', role: 'assistant', content: 'Before.' },
      { type: 'tool_started', toolCallId: 'call-1', toolName: 'Read', toolInput: {} },
      { type: 'tool_completed', toolCallId: 'call-1', toolName: 'Read', result: 'file', isError: false },
      { type: 'message_delta', role: 'assistant', content: 'After.' },
      { type: 'message_completed', role: 'assistant', content: 'After.' },
    ];
    for (const event of events) {
      act(() => emit(event));
      expect(result.current.isStreaming).toBe(true);
    }
    act(() => emit({ type: 'session_ended', reason: 'completed' }));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages.map(({ role, content, result }) => ({ role, content, result }))).toEqual([
      { role: 'assistant', content: 'Before.', result: undefined },
      { role: 'tool', content: undefined, result: 'file' },
      { role: 'assistant', content: 'After.', result: undefined },
    ]);
  });

  it('retires running state on session change and does not retain it after an error', async () => {
    const { result, rerender } = renderHook(({ sessionId }) => useStructuredSession({ sessionId, runtime: 'claude' }), { initialProps: { sessionId: 'ss-first' } });
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ type: 'session_started' }));
    rerender({ sessionId: 'ss-second' });
    expect(result.current.isStreaming).toBe(false);
    act(() => emit({ type: 'message_completed', role: 'assistant', content: 'Historical answer.' }));
    expect(result.current.isStreaming).toBe(false);
    act(() => { emit({ type: 'session_started' }); emit({ type: 'error', message: 'Process failed.' }); });
    expect(result.current.isStreaming).toBe(false);
    act(() => emit({ type: 'message_completed', role: 'assistant', content: 'Recovered history.' }));
    expect(result.current.isStreaming).toBe(false);
  });
});
