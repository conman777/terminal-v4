import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
vi.mock('../utils/auth', async original => ({ ...await original(), isAccessTokenExpired: () => false }));
import { apiFetch } from '../utils/api';
import { setTokens, setUser, clearTokens } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { useStructuredSession } from './useStructuredSession';

class Socket {
 static instances = [];
 constructor(url) { this.url = url;Socket.instances.push(this); }
 close() { this.onclose?.({ code: 1000 }); }
}
const originalSocket = globalThis.WebSocket;
const sessionId = 'ss-synthetic-recovery';
const snapshot = { id: sessionId, events: [
 { type: 'message_delta', role: 'assistant', messageId: 'canonical-message', turnId: 'canonical-turn', content: 'Hello', ts: 1, seq: 1 },
 { type: 'message_completed', role: 'assistant', messageId: 'canonical-message', turnId: 'canonical-turn', content: 'Hello world', ts: 2, seq: 2 },
] };
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
 vi.useFakeTimers();apiFetch.mockReset();Socket.instances=[];globalThis.WebSocket=Socket;
 setTokens('synthetic-access','synthetic-refresh');setUser({ id:'synthetic-owner' });setEnvironmentIdentity('synthetic-owner');
 setActiveEnvironment({ id:'synthetic-remote', capabilities:{ agentExecute:false } });
});
afterEach(() => { clearTokens(true);setEnvironmentIdentity(null);globalThis.WebSocket=originalSocket;vi.useRealTimers(); });
const mount = () => renderHook(() => useStructuredSession({ sessionId, runtime:'codex', active:true }));

it.each(['codex', 'v4'])('explicit %s reconnect preserves history, cleanup, draft and gates until the replacement socket opens', async runtime => {
 setActiveEnvironment({ id:'synthetic-controller', capabilities:{ agentExecute:true } });
 apiFetch.mockResolvedValue(response(snapshot));
 const store=getComposerDraftStore(sessionId); store.setText('Keep reconnect draft');
 const hook=renderHook(()=>useStructuredSession({sessionId,runtime,active:true,status:'cleanup_required',statusSeq:3}));
 const first=Socket.instances[0];
 await act(async()=>{first.onclose({code:1009});await vi.advanceTimersByTimeAsync(0);});
 const before=hook.result.current.messages;
 expect(hook.result.current.isHistoryOnly).toBe(true);
 act(()=>hook.result.current.reconnect());
 expect(Socket.instances.length).toBe(2);
 const second=Socket.instances[1];
 expect(second.url).toContain('last_seq=2');
 expect([hook.result.current.messages,hook.result.current.isHistoryOnly,hook.result.current.requiresCleanup,store.getSnapshot().text]).toEqual([before,true,true,'Keep reconnect draft']);
 const obsolete={...snapshot.events[1],seq:3,content:'obsolete socket'};
 act(()=>first.onmessage?.({data:JSON.stringify({__terminal_meta:true,type:'structured_event',event:obsolete})}));
 expect(hook.result.current.messages).toEqual(before);
 act(()=>second.onopen());
 expect([hook.result.current.isHistoryOnly,hook.result.current.connectionState,hook.result.current.requiresCleanup,hook.result.current.actionError]).toEqual([false,'online',true,'']);
 act(()=>second.onmessage({data:JSON.stringify({__terminal_meta:true,type:'structured_event',event:snapshot.events[1]})}));
 expect(hook.result.current.messages).toEqual(before);
 hook.unmount();
});

it('keeps the V4 projector, streaming state, running tool and approval across a live reconnect', () => {
 const hook=renderHook(()=>useStructuredSession({sessionId,runtime:'v4',active:true}));
 const first=Socket.instances[0];
 const emit=(socket,event)=>socket.onmessage({data:JSON.stringify({__terminal_meta:true,type:'structured_event',event})});
 const events=[
  {seq:1,type:'turn_started',turnId:'owned-turn'},
  {seq:2,type:'message_delta',turnId:'owned-turn',messageId:'owned-message',role:'assistant',content:'Partial'},
  {seq:3,type:'tool_started',turnId:'owned-turn',toolCallId:'owned-tool',toolName:'read_file',toolInput:{path:'/owned/file'}},
  {seq:4,type:'approval_required',turnId:'owned-turn',toolCallId:'owned-tool',approvalId:'owned-approval'},
 ];
 act(()=>events.forEach(event=>emit(first,event)));
 const project=()=>({messages:hook.result.current.messages,controls:hook.result.current.controlState,tools:hook.result.current.currentToolCalls,approval:hook.result.current.pendingApproval,streaming:hook.result.current.isStreaming});
 const before=project();
 act(()=>hook.result.current.reconnect());
 expect(project()).toEqual(before);
 const second=Socket.instances[1];expect(second.url).toContain('last_seq=4');
 act(()=>{second.onopen();events.forEach(event=>emit(second,event));});
 expect(project()).toEqual(before);
 hook.unmount();
});

it('loads owned HTTP history once after 1009, replaces partial replay canonically and stops reconnecting', async () => {
 apiFetch.mockResolvedValue(response(snapshot));
 const hook=mount();const socket=Socket.instances[0];
 act(() => socket.onmessage({ data:JSON.stringify({ __terminal_meta:true,type:'structured_event',event:snapshot.events[0] }) }));
 await act(async () => { socket.onclose({ code:1009,reason:'Relay message limit exceeded' }); await vi.advanceTimersByTimeAsync(0); });
 expect(hook.result.current.messages).toEqual([expect.objectContaining({ role:'assistant',content:'Hello world',messageId:'canonical-message',turnId:'canonical-turn' })]);
 expect(hook.result.current.actionError).toMatch(/saved history.*live updates.*paused/i);
 expect(hook.result.current.connectionState).toBe('unavailable');
 await act(async () => { window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(60000); });
 expect([Socket.instances.length,apiFetch.mock.calls.map(([path])=>path)]).toEqual([1,[`/api/structured/sessions/${sessionId}`]]);
 hook.unmount();
});

it.each([401,403,404])('keeps a visible recovery failure and never retries or mutates after HTTP %s', async status => {
 apiFetch.mockResolvedValue(new Response('',{status}));
 const hook=mount();
 await act(async () => { Socket.instances[0].onclose({code:1009});await vi.advanceTimersByTimeAsync(60000); });
 expect([hook.result.current.messages,Socket.instances.length,apiFetch.mock.calls.length]).toEqual([[],1,1]);
 expect(hook.result.current.actionError).toMatch(/could not load saved history.*direct connection/i);
 expect(apiFetch.mock.calls[0][1].method).toBeUndefined();hook.unmount();
});

it('rejects oversized HTTP history before reading and aborts its request', async () => {
 const reader=vi.fn();
 apiFetch.mockResolvedValue({ok:true,headers:new Headers({'content-length':String(20*1024*1024+1)}),body:{getReader:reader}});
 const hook=mount();
 await act(async () => { Socket.instances[0].onclose({code:1009});await vi.advanceTimersByTimeAsync(0); });
 expect(reader).not.toHaveBeenCalled();expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
 expect(hook.result.current.actionError).toMatch(/history.*limit.*direct connection/i);hook.unmount();
});

it.each(['auth','environment','unmount'])('discards and aborts a stale HTTP recovery after %s changes', async kind => {
 let resolve;apiFetch.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 const hook=mount();await act(async()=>Socket.instances[0].onclose({code:1009}));
 const signal=apiFetch.mock.calls[0][1].signal;
 act(()=>{ if(kind==='auth') clearTokens(true);else if(kind==='environment') setActiveEnvironment({id:'other-host'});else hook.unmount(); });
 expect(signal.aborted).toBe(true);
 await act(async()=>{resolve(response(snapshot));await vi.advanceTimersByTimeAsync(0);});
 if(kind!=='unmount') {expect(hook.result.current.messages).toEqual([]);hook.unmount();}
 expect(apiFetch).toHaveBeenCalledTimes(1);
});

it.each(['session','sequence'])('rejects invalid %s identity without replacing already visible text', async kind => {
 apiFetch.mockResolvedValue(response(kind==='session'?{...snapshot,id:'another-owned-session'}:{...snapshot,events:[snapshot.events[0],{...snapshot.events[1],seq:3}]}));
 const hook=mount();act(()=>Socket.instances[0].onmessage({data:JSON.stringify({__terminal_meta:true,type:'structured_event',event:snapshot.events[0]})}));
 await act(async()=>{Socket.instances[0].onclose({code:1009});await vi.advanceTimersByTimeAsync(0);});
 expect(hook.result.current.messages.map(message=>message.content)).toEqual(['Hello']);
 expect(hook.result.current.actionError).toMatch(/could not load saved history/i);hook.unmount();
});

it('bounds chunked history without Content-Length and cancels the reader', async () => {
 let cancelled=false;
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(20*1024*1024));controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
 apiFetch.mockResolvedValue(new Response(body));const hook=mount();
 await act(async()=>{Socket.instances[0].onclose({code:1009});await vi.advanceTimersByTimeAsync(0);});
 expect([cancelled,apiFetch.mock.calls[0][1].signal.aborted]).toEqual([true,true]);
 expect(hook.result.current.actionError).toMatch(/exceeds the recovery limit/);hook.unmount();
});
it('stops a stalled history body after fifteen seconds and shows a retryable recovery message', async () => {
 let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}});
 apiFetch.mockResolvedValue(new Response(body));const hook=mount();
 await act(async()=>{Socket.instances[0].onclose({code:1009});await vi.advanceTimersByTimeAsync(15001);});
 expect([cancelled,apiFetch.mock.calls[0][1].signal.aborted,Socket.instances.length]).toEqual([true,true,1]);
 expect(hook.result.current.actionError).toMatch(/timed out.*reload/);hook.unmount();
});

it.each(['codex','v4'])('synchronously blocks captured %s Send and retry callbacks at 1009 without changing the saved draft', async runtime => {
 setActiveEnvironment({ id:'synthetic-controller', capabilities:{ agentExecute:true } });
 apiFetch.mockResolvedValue(response(snapshot));
 const store=getComposerDraftStore(sessionId);store.setText('Retain this controller draft');
 const before=store.getSnapshot();
 const hook=renderHook(()=>useStructuredSession({sessionId,runtime,active:true}));
 const {sendMessage,retryPendingMessage}=hook.result.current;let sent,retried;
 await act(async()=>{
  Socket.instances[0].onclose({code:1009});
  sent=await sendMessage(before.text);retried=await retryPendingMessage();
 });
 expect([sent,retried]).toEqual([{accepted:false,historyOnly:true},runtime==='v4'?{accepted:false,historyOnly:true}:{accepted:false}]);
 expect(apiFetch.mock.calls.map(([path,options])=>[path,options?.method||'GET'])).toEqual([[`/api/structured/sessions/${sessionId}`,'GET']]);
 expect(store.getSnapshot()).toMatchObject({text:before.text,revision:before.revision,pending:before.pending});
 expect(hook.result.current.isHistoryOnly).toBe(true);hook.unmount();
});

it('does not post a send that was awaiting preparation when the transport becomes history-only', async () => {
 setActiveEnvironment({id:'synthetic-controller',capabilities:{agentExecute:true}});
 apiFetch.mockResolvedValue(response(snapshot));
 const store=getComposerDraftStore(sessionId);store.setText('Held during preparation');
 const prepare=store.prepareIntent.bind(store);let release;
 const preparation=vi.spyOn(store,'prepareIntent').mockImplementation(text=>new Promise(done=>{release=()=>done(prepare(text));}));
 const hook=mount();let sending;
 act(()=>{sending=hook.result.current.sendMessage('Held during preparation');});
 await act(async()=>{Socket.instances[0].onclose({code:1009});release();await sending;});
 expect(await sending).toEqual({accepted:false,historyOnly:true});
 expect(apiFetch.mock.calls.map(([path])=>path)).toEqual([`/api/structured/sessions/${sessionId}`]);
 expect(store.getSnapshot()).toMatchObject({text:'Held during preparation',isSending:false});
 preparation.mockRestore();hook.unmount();
});

it.each(['auth','environment'])('captured controller callbacks take no action after a %s scope change during history-only recovery', async kind=>{
 setActiveEnvironment({id:'synthetic-controller',capabilities:{agentExecute:true}});
 apiFetch.mockResolvedValue(response(snapshot));
 const hook=renderHook(()=>useStructuredSession({sessionId,runtime:'v4',active:true}));
 const {sendMessage,retryPendingMessage}=hook.result.current;
 await act(async()=>Socket.instances[0].onclose({code:1009}));
 act(()=>{if(kind==='auth')clearTokens(true);else setActiveEnvironment({id:'another-controller',capabilities:{agentExecute:true}});});
 const calls=apiFetch.mock.calls.length;
 await act(async()=>{expect((await sendMessage('Stale draft')).accepted).toBe(false);expect((await retryPendingMessage()).accepted).toBe(false);});
 expect(apiFetch).toHaveBeenCalledTimes(calls);hook.unmount();
});
