import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../utils/api', () => ({ apiFetch:vi.fn(), uploadScreenshot:vi.fn() }));
vi.mock('../utils/auth', async original => ({...await original(),isAccessTokenExpired:()=>false}));
vi.mock('../utils/windowActivity',()=>({isWindowActive:()=>true,subscribeWindowActivity:()=>()=>{}}));
vi.mock('../contexts/TerminalSessionContext',()=>({useTerminalSession:()=>({refreshSessionGitStats:()=>{},listSessionGitBranches:async()=>({branches:[]}),checkoutSessionGitBranch:async()=>{},sendToSession:()=>{},updateThreadMetadata:async()=>{}})}));
vi.mock('../contexts/AutocorrectContext',()=>({useAutocorrect:()=>({autocorrectEnabled:false,toggleAutocorrect:()=>{}})}));
vi.mock('../hooks/useMobileChatTurns',()=>({useMobileChatTurns:()=>({turns:[],isLoading:false,isSendReady:true,handleTurn:()=>{},handleRegisterSendText:()=>{},handleChatSend:()=>{},handleRawSend:()=>{}})}));
vi.mock('./WorkspaceToolsButton',()=>({WorkspaceToolsButton:()=>null}));
vi.mock('./WorkspaceProfileButton',()=>({WorkspaceProfileButton:()=>null}));
import { apiFetch } from '../utils/api';
import { setTokens, setUser, clearTokens } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { TerminalPane } from './TerminalPane';
import { MobileShell } from './MobileShell';
const originalSocket=globalThis.WebSocket;
class Socket {static instances=[];constructor(){Socket.instances.push(this);}close(){this.onclose?.({code:1000});}}
const session={id:'ss-controller-recovery',runtime:'codex',provider:'codex',shell:'codex',cwd:'/synthetic/work',title:'Synthetic controller',status:'idle',thread:{projectPath:'/synthetic/work'}};
beforeEach(()=>{
 localStorage.clear();Socket.instances=[];globalThis.WebSocket=Socket;
 setTokens('synthetic-access','synthetic-refresh');setUser({id:'synthetic-controller'});setEnvironmentIdentity('synthetic-controller');setActiveEnvironment({id:'remote-controller',capabilities:{agentExecute:true}});
 apiFetch.mockReset().mockImplementation(async (path,options={})=>{
  if(path.includes('/input'))return {ok:true,json:async()=>({status:'accepted',requestId:options.body.requestId,messageId:'synthetic-new',turnId:'synthetic-turn',acceptedSeq:3})};
  return new Response(JSON.stringify(path.includes('/api/agent/catalog')?{agents:[]}:{id:session.id,events:[{type:'message_completed',role:'assistant',messageId:'saved',content:'Saved response',ts:1,seq:1}]}),{headers:{'content-type':'application/json'}});
 });
});
afterEach(()=>{clearTokens(true);setEnvironmentIdentity(null);globalThis.WebSocket=originalSocket;});
it.each(['desktop','mobile'])('actual %s controller keeps the draft editable while blocking Send after a 1009 history-only recovery',async surface=>{
 const view=render(surface==='desktop'?<TerminalPane pane={{id:'synthetic-pane',sessionId:session.id}} sessions={[session]} isActive onFocus={()=>{}} />:<MobileShell sessions={[session]} activeSessionId={session.id} projectInfo={{cwd:session.cwd}} viewportHeight={800} mobileView="terminal" />);
 await waitFor(()=>expect(Socket.instances).toHaveLength(1));
 await act(async()=>{Socket.instances[0].onopen?.();});
 const composer=screen.getByRole('textbox',{name:/command composer/i});
 fireEvent.change(composer,{target:{value:'Keep this controller draft'}});
 expect(screen.getByRole('button',{name:'Send message'})).toBeEnabled();
 const savedDraft=getComposerDraftStore(session.id).getSnapshot();
 await act(async()=>{Socket.instances[0].onclose({code:1009,reason:'Relay message limit exceeded'});});
 expect(await screen.findByRole('status',{name:'Connection recovery'})).toHaveTextContent(/Saved history loaded; live updates are paused/);
 expect(composer).toBeEnabled();
 expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Send message'}));
 fireEvent.keyDown(composer,{key:'Enter',code:'Enter'});
 expect(apiFetch.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([]);
 expect(getComposerDraftStore(session.id).getSnapshot()).toMatchObject({text:savedDraft.text,revision:savedDraft.revision,pending:savedDraft.pending});
 fireEvent.change(composer,{target:{value:'Edited while history-only'}});
 expect(getComposerDraftStore(session.id).getSnapshot().text).toBe('Edited while history-only');
 view.unmount();
});

it.each(['desktop','mobile'])('actual %s observer remains read-only after history recovery', async surface=>{
 setActiveEnvironment({id:'remote-observer',capabilities:{agentExecute:false}});
 const view=render(surface==='desktop'?<TerminalPane pane={{id:'observer-pane',sessionId:session.id}} sessions={[session]} isActive onFocus={()=>{}} />:<MobileShell sessions={[session]} activeSessionId={session.id} projectInfo={{cwd:session.cwd}} viewportHeight={800} mobileView="terminal" />);
 await waitFor(()=>expect(Socket.instances).toHaveLength(1));
 await act(async()=>Socket.instances[0].onclose({code:1009}));
 expect(await screen.findByRole('status',{name:'Connection recovery'})).toHaveTextContent(/Saved history loaded; live updates are paused/);
 expect(screen.getByRole('textbox',{name:/command composer/i})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();
 expect(apiFetch.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([]);view.unmount();
});
