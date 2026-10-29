import React from 'react';
import {it,expect,vi,beforeEach} from 'vitest';
import {renderHook,act,waitFor} from '@testing-library/react';
import {TerminalSessionProvider,useTerminalSession} from './TerminalSessionContext.jsx';
import {clearTokens,setUser} from '../utils/auth';
import {setActiveEnvironment,setEnvironmentIdentity} from '../utils/remoteEnvironments';
const {apiFetch}=vi.hoisted(()=>({apiFetch:vi.fn()}));
vi.mock('../utils/api',()=>({apiFetch}));
vi.mock('./FolderContext',()=>({useFolders:()=>({recentFolders:[],addRecentFolder:()=>{}})}));
const sessions=[{id:'terminal-one',isActive:true,shell:'/bin/sh',title:'Synthetic terminal',thread:{projectPath:'/synthetic'}},{id:'terminal-two',isActive:true,shell:'/bin/sh',title:'Second synthetic terminal',thread:{projectPath:'/synthetic'}}];
const snapshot={id:'ss-fixture',provider:'codex',runtime:'codex',cwd:'/synthetic',title:'Synthetic conversation',createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z'};
const response=data=>({ok:true,status:200,json:async()=>data});
let inventoryFails=false, deferredCreate, deferredStructured;
beforeEach(()=>{localStorage.clear();inventoryFails=false;deferredCreate=null;deferredStructured=null;apiFetch.mockReset();apiFetch.mockImplementation(async(url,options={})=>{
 if(url==='/api/structured/sessions'&&options.method==='POST')return new Promise(resolve=>{deferredStructured=resolve});
 if(url==='/api/terminal'&&options.method==='POST')return new Promise(resolve=>{deferredCreate=resolve});
 if(url==='/api/terminal')return response({sessions});
 if(url==='/api/structured/sessions?view=inventory'){if(inventoryFails)return {ok:false,status:503};return response([snapshot]);}
 if(url.endsWith('/input'))return response({});
 throw Error('Unexpected synthetic request '+url);
});});
const wrapper=({children})=><TerminalSessionProvider>{children}</TerminalSessionProvider>;
it('rejects structured workspace navigation without sending input', async () => {
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 await expect(result.current.navigateSession(snapshot.id,'/synthetic/other')).rejects.toThrow('fixed workspace');
 expect(apiFetch.mock.calls.filter(([url])=>url.endsWith('/input'))).toEqual([]);
 expect(result.current.sessions.find(session=>session.id===snapshot.id).cwd).toBe('/synthetic');
});

it('a creation without newer selection selects its result',async()=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 let creation;
 act(()=>{creation=result.current.createSession({cwd:'/synthetic'})});
 await waitFor(()=>expect(deferredCreate).toBeTypeOf('function'));
 await act(async()=>{deferredCreate(response({session:{id:'created-current'}}));await creation});
 expect(result.current.activeSessionId).toBe('created-current');
});
it('retains the known structured inventory and reports a failed refresh',async()=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 act(()=>result.current.selectSession(snapshot.id));
 expect(result.current.sessions.map(s=>s.id)).toContain(snapshot.id);
 inventoryFails=true;
 await act(async()=>{await result.current.retryLoadSessions()});
 expect(result.current.sessions.map(s=>s.id)).toContain(snapshot.id);
 expect(result.current.activeSessionId).toBe(snapshot.id);
 expect(result.current.sessionLoadError).toMatch(/503/);
});
it('preserves newer explicit selection after delayed terminal creation',async()=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 let creation;
 act(()=>{creation=result.current.createSession({cwd:'/synthetic'})});
 await waitFor(()=>expect(deferredCreate).toBeTypeOf('function'));
 act(()=>result.current.selectSession('terminal-two'));
 expect(result.current.activeSessionId).toBe('terminal-two');
 await act(async()=>{deferredCreate(response({session:{id:'created-late'}}));await creation});
 expect(result.current.activeSessionId).toBe('terminal-two');
});
it.each([403,404,500])('rejects failed terminal HTTP input (%s)',async(status)=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 apiFetch.mockResolvedValueOnce({ok:false,status});
 await expect(result.current.sendToSession('terminal-one','synthetic text')).rejects.toThrow(String(status));
});
it('returns the registered transport receipt, including failure',async()=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 act(()=>result.current.registerTerminalSender('terminal-one',()=>Promise.reject(new Error('Synthetic transport failure'))));
 await expect(result.current.sendToSession('terminal-one','synthetic text')).rejects.toThrow('Synthetic transport failure');
});
it.each([['home','raw text'],['home','\x1b[A'],['paired','raw text'],['paired','\x1b[A']])('sends legacy raw text with message fallback disabled on %s',async(target,text)=>{
 setUser({id:'raw-transport-owner'});setEnvironmentIdentity('raw-transport-owner');
 if(target==='paired')setActiveEnvironment({id:'paired-fixture',capabilities:{agentExecute:true,terminalInput:true}});
 const previous=apiFetch.getMockImplementation();
 apiFetch.mockImplementation(async(url,options={})=>{
  if(url==='/api/structured/sessions?view=inventory')return response([{...snapshot,provider:'claude',runtime:'claude'}]);
  return url.endsWith('/input-capabilities')?{ok:false,status:404}:previous(url,options);
 });
 try{
  const {result}=renderHook(()=>useTerminalSession(),{wrapper});
  await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
  await act(async()=>{await result.current.sendRawToSession(snapshot.id,text,{requireLegacy:true})});
  const writes=apiFetch.mock.calls.filter(([url])=>url===`/api/structured/sessions/${snapshot.id}/input`);
  expect(writes.map(([,options])=>options.body)).toEqual([{text,fallbackToMessage:false}]);
 }finally{setActiveEnvironment(null);setEnvironmentIdentity(null);clearTokens(true)}
});
it('preserves a Claude composer message conflict instead of sending it as raw input',async()=>{
 const previous=apiFetch.getMockImplementation();
 apiFetch.mockImplementation(async(url,options={})=>{
  if(url==='/api/structured/sessions?view=inventory')return response([{...snapshot,provider:'claude',runtime:'claude'}]);
  if(url.endsWith('/input'))return {ok:false,status:409,json:async()=>({error:'Conversation busy'})};
  return previous(url,options);
 });
 const consoleError=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const {result}=renderHook(()=>useTerminalSession(),{wrapper});
  await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
  await expect(result.current.sendToSession(snapshot.id,'composer draft')).rejects.toThrow('409');
  const writes=apiFetch.mock.calls.filter(([url])=>url===`/api/structured/sessions/${snapshot.id}/input`);
  expect(writes.map(([,options])=>options.body)).toEqual([{text:'composer draft',fallbackToMessage:true}]);
 }finally{consoleError.mockRestore()}
});
it.each(['timeout','partial','network'])('marks legacy %s input as possibly delivered without resending',async(outcome)=>{
 setUser({id:'raw-transport-owner'});setEnvironmentIdentity('raw-transport-owner');
 const previous=apiFetch.getMockImplementation();
 apiFetch.mockImplementation(async(url,options={})=>{
  if(url.endsWith('/input-capabilities'))return {ok:false,status:404};
  if(url.endsWith('/input')){
   if(outcome==='network')throw new TypeError('Synthetic connection lost');
   return {ok:false,status:409,json:async()=>({outcome:'uncertain',reason:outcome})};
  }
  return previous(url,options);
 });
 try{
  const {result}=renderHook(()=>useTerminalSession(),{wrapper});
  await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
  await expect(result.current.sendRawToSession(snapshot.id,'x',{requireLegacy:true})).rejects.toMatchObject({deliveryUncertain:true,message:expect.stringMatching(/may have been delivered/i)});
  expect(apiFetch.mock.calls.filter(([url])=>url===`/api/structured/sessions/${snapshot.id}/input`)).toHaveLength(1);
 }finally{setEnvironmentIdentity(null);clearTokens(true)}
});
it('navigates literal shell metacharacters through the real context helper',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const cp=await import('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-nav-audit-'));
 try{
  const folder=path.join(dir,'$(touch AUDIT_MARKER)`touch SECOND_MARKER` $HOME "double" single\'quote');fs.mkdirSync(folder);
  const {result}=renderHook(()=>useTerminalSession(),{wrapper});
  await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
  await act(async()=>{await result.current.navigateSession('terminal-one',folder)});
  const request=apiFetch.mock.calls.find(([url])=>url==='/api/terminal/terminal-one/input');
  const command=JSON.parse(request[1].body).command.replace(/\r$/,'');
  const observed=cp.spawnSync('/bin/sh',['-c',command+'; pwd'],{cwd:dir,encoding:'utf8'});
  expect(fs.existsSync(path.join(dir,'AUDIT_MARKER'))).toBe(false);
  expect(fs.existsSync(path.join(dir,'SECOND_MARKER'))).toBe(false);
  expect(observed.stdout.trim()).toBe(folder);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

it('preserves newer explicit selection after delayed structured creation',async()=>{
 const {result}=renderHook(()=>useTerminalSession(),{wrapper});
 await waitFor(()=>expect(result.current.loadingSessions).toBe(false));
 let creation;
 act(()=>{creation=result.current.createStructuredSession({cwd:'/synthetic',provider:'codex'})});
 await waitFor(()=>expect(deferredStructured).toBeTypeOf('function'));
 act(()=>result.current.selectSession('terminal-two'));
 await act(async()=>{deferredStructured(response({...snapshot,id:'ss-created-late'}));await creation});
 expect(result.current.activeSessionId).toBe('terminal-two');
});
