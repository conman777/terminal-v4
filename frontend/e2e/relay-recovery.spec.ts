import { test, expect, chromium } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const browserTest = test;
const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const apiBinary = process.env.E2E_RELAY_API_BIN;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;
}
function token(secret, owner) {
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const now=Math.floor(Date.now()/1000);const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:owner,username:owner,exp:now+3600,iat:now,token_kind:'access'});
 return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
}
async function request(host, method, pathname, body) {
 const response=await fetch(host.url+pathname,{method,headers:{Authorization:'Bearer '+host.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();if(!response.ok)throw new Error(`Synthetic API ${method} ${pathname}: ${response.status} ${text.slice(0,200)}`);
 return text?JSON.parse(text):null;
}
async function startHost(root,name,owner,extra={}) {
 const directory=path.join(root,name);await mkdir(directory,{recursive:true});await mkdir(path.join(directory,'empty-home'));
 const listenPort=await port();const secret='synthetic-relay-recovery-'+name+'-signing-secret';
 const child=spawn(apiBinary,[],{cwd:directory,env:{PATH:'/usr/bin:/bin',HOME:path.join(directory,'empty-home'),HOST:'127.0.0.1',PORT:String(listenPort),JWT_SECRET:secret,TERMINAL_DATA_DIR:path.join(directory,'data'),CODEX_HOME:path.join(directory,'empty-home'),CLAUDE_CONFIG_DIR:path.join(directory,'empty-home'),...extra},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output=(output+data).slice(-20000);});child.stderr.on('data',data=>{output=(output+data).slice(-20000);});
 const host={child,directory,url:`http://127.0.0.1:${listenPort}`,token:token(secret,owner),owner};
 try {
  for(let attempt=0;attempt<300;attempt++) {try { const response=await fetch(host.url+'/api/health');if(response.ok)return host; }catch{}if(child.exitCode!==null)throw new Error(output);await delay(50);}
  throw new Error('Synthetic API startup timed out: '+output);
 }catch(error){child.kill('SIGKILL');throw error;}
}
async function stopHost(host) {
 if(!host||host.child.exitCode!==null)return;
 const ended=new Promise(resolve=>host.child.once('exit',resolve));host.child.kill('SIGTERM');
 const deadline=setTimeout(()=>host.child.kill('SIGKILL'),15000);await ended;clearTimeout(deadline);
}
async function legacyRegistration(broker) {
 const server=createServer((_request,response)=>{response.statusCode=404;response.end();});
 const sockets=new Set();const acceptor=new WebSocketServer({noServer:true,maxPayload:66560});
 server.on('upgrade',(request,socket,head)=>{
  if(!/^\/api\/relay\/hosts\/[0-9a-f-]+\/register$/.test(request.url)){socket.destroy();return;}
  const headers={};for(const [name,value] of Object.entries(request.headers))if(!['host','connection','upgrade','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','x-terminal-v4-relay-fragments'].includes(name))headers[name]=value;
  const upstream=new WebSocket(broker.url.replace('http:','ws:')+request.url,{headers,maxPayload:66560});sockets.add(upstream);
  upstream.once('open',()=>acceptor.handleUpgrade(request,socket,head,downstream=>{
   sockets.add(downstream);
   downstream.on('message',(body,binary)=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(body,{binary});});
   upstream.on('message',(body,binary)=>{if(downstream.readyState===WebSocket.OPEN)downstream.send(body,{binary});});
   downstream.on('close',()=>{sockets.delete(downstream);upstream.close();});upstream.on('close',()=>{sockets.delete(upstream);downstream.close();});
  }));
  upstream.on('error',()=>socket.destroy());
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{for(const socket of sockets)socket.terminate();acceptor.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const probe = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useStructuredSession} from '/src/hooks/useStructuredSession.js';
import {setTokens,setUser} from '/src/utils/auth.js';
import {setEnvironmentIdentity,setActiveEnvironment} from '/src/utils/remoteEnvironments.js';
const input=window.syntheticRelay;
setTokens(input.token,'synthetic-refresh');setUser({id:input.owner});setEnvironmentIdentity(input.owner);setActiveEnvironment(input.environment);
window.socketAttempts=0;window.socketCloses=[];const NativeSocket=window.WebSocket;
window.WebSocket=class extends NativeSocket {constructor(...args){super(...args);window.socketAttempts++;this.addEventListener('close',event=>window.socketCloses.push({code:event.code,reason:event.reason}));}};
function Probe(){const state=useStructuredSession({sessionId:input.sessionId,runtime:'codex',active:true});window.relayState=state;
return React.createElement('main',null,React.createElement('h1',null,'Synthetic relay recovery'),React.createElement('p',{role:'alert'},state.actionError),React.createElement('output',{'data-testid':'connection'},state.connectionState),React.createElement('output',{'data-testid':'length'},state.messages.reduce((n,m)=>n+m.content.length,0)));}
if(input.surface){
 await Promise.all([import('/src/styles.css'),import('/src/WorkspaceShell.css'),import('/src/ProUI.css'),import('/src/ProTerminalEmpty.css')]);
 const [{TerminalPane},{MobileShell},{AutocorrectProvider},{getComposerDraftStore}]=await Promise.all([import('/src/components/TerminalPane.jsx'),import('/src/components/MobileShell.jsx'),import('/src/contexts/AutocorrectContext.jsx'),import('/src/utils/composerDraftStore.js')]);
 const session={id:input.sessionId,runtime:'codex',provider:'codex',shell:'codex',status:'idle',cwd:'/synthetic/work',title:'Synthetic controller',thread:{projectPath:'/synthetic/work'}};
 window.readComposerDraft=()=>getComposerDraftStore(session.id).getSnapshot();
 const caller=input.surface==='desktop'?React.createElement(TerminalPane,{pane:{id:'synthetic-pane',sessionId:session.id},sessions:[session],isActive:true,onFocus:()=>{}}):React.createElement(MobileShell,{sessions:[session],activeSessionId:session.id,projectInfo:{cwd:session.cwd},viewportHeight:800,mobileView:'terminal'});
 createRoot(document.getElementById('root')).render(React.createElement(AutocorrectProvider,null,React.createElement('div',{className:'environment-workspace layout'+(input.surface==='mobile'?' mobile':'')},caller)));
}else createRoot(document.getElementById('root')).render(React.createElement(Probe));`;

browserTest('actual paired hook recovers legacy and oversized events once, while upgraded events remain live',async()=>{
 test.skip(process.env.E2E_RELAY_RECOVERY !== '1','Requires a parent-built isolated API fixture');
 test.setTimeout(240000);
 if(!apiBinary)throw new Error('E2E_RELAY_API_BIN must name the parent-built current API');
 const binarySha256=createHash('sha256').update(await readFile(apiBinary)).digest('hex');
 if(process.env.E2E_RELAY_API_SHA256)expect(binarySha256).toBe(process.env.E2E_RELAY_API_SHA256);
 const startedAt=new Date().toISOString();
 const root=await mkdtemp(path.join(tmpdir(),'terminal-relay-recovery-'));const evidence=[];
 const browser=await chromium.launch({headless:true,executablePath:process.env.E2E_LOCAL_BROWSER||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
 try {
  for(const mode of (process.env.E2E_RELAY_MODES?.split(',')||['legacy','upgraded','oversized','revoked','controller-desktop','controller-mobile'])) {
   const caseRoot=path.join(root,mode);await mkdir(caseRoot);const hosts=[];let shim,vite,context;
   try {
    const key='synthetic-three-host-relay-recovery-key-32-chars';
    const broker=await startHost(caseRoot,'broker','broker-owner',{TERMINAL_V4_RELAY_SERVER_KEY:key});hosts.push(broker);
    if(mode==='legacy'||mode==='revoked'||mode.startsWith('controller-'))shim=await legacyRegistration(broker);
    const target=await startHost(caseRoot,'target','remote-owner',{TERMINAL_V4_RELAY_URL:shim?.url||broker.url,TERMINAL_V4_RELAY_KEY:key});hosts.push(target);
    const home=await startHost(caseRoot,'home','home-owner');hosts.push(home);
    let status;for(let attempt=0;attempt<150;attempt++){status=await request(target,'GET','/api/relay/status');if(status.connected)break;await delay(50);}expect(status.connected).toBe(true);
    const code=await request(target,'POST','/api/environments/pairing-code',{label:'Synthetic relay recovery',profile:mode.startsWith('controller-')?'operator':'observer'});
    const environment=await request(home,'POST','/api/environments/connect',{relayUrl:broker.url,deviceId:status.deviceId,code:code.code,label:'Synthetic remote'});
    const sessionId='ss-44444444444444448444444444444444';
    const content=mode==='oversized'?'X'.repeat(9*1024*1024):'synthetic ∆'.repeat(10000);
    const folder=path.join(target.directory,'data','structured-sessions',createHash('sha256').update('remote-owner').digest('hex'));await mkdir(folder,{recursive:true});
    const events=[{type:'message_completed',role:'assistant',messageId:'first',turnId:'turn',content:'prefix|',ts:1,seq:1},{type:'message_completed',role:'assistant',messageId:'large',turnId:'turn',content,ts:2,seq:2}];
    const snapshot={id:sessionId,title:'Synthetic relay recovery',cwd:target.directory,provider:'codex',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',events};
    await writeFile(path.join(folder,sessionId+'.json'),JSON.stringify({version:1,ownerId:'remote-owner',snapshot}));
    const input={sessionId,token:home.token,owner:home.owner,environment,...(mode.startsWith('controller-')?{surface:mode.slice('controller-'.length)}:{})};
    vite=await createViteServer({configFile:false,root:frontendRoot,envDir:caseRoot,cacheDir:path.join(caseRoot,'vite-cache'),logLevel:'error',plugins:[react(),{name:'relay-probe',enforce:'pre',resolveId(id){if(id==='virtual:relay-probe')return '\0relay-probe';if(id.includes('contexts/TerminalSessionContext'))return '\0relay-fixture-context';},load(id){if(id==='\0relay-probe')return probe;if(id==='\0relay-fixture-context')return `const context={refreshSessionGitStats:()=>{},listSessionGitBranches:async()=>({branches:[]}),checkoutSessionGitBranch:async()=>{},sendToSession:()=>{},updateThreadMetadata:async()=>{}};export const useTerminalSession=()=>context;`;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/relay-recovery.html')return next();try{const html=await server.transformIndexHtml('/relay-recovery.html','<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script>window.syntheticRelay='+JSON.stringify(input)+'</script><script type="module">import "virtual:relay-probe"</script></body></html>');res.setHeader('content-type','text/html');res.end(html);}catch(error){next(error);}});}}],optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime']},server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:home.url,ws:true}}}});
    await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
    context=await browser.newContext(mode==='controller-mobile'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{});const page=await context.newPage();const errors=[];const historyRequests=[];const mutations=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))mutations.push(request.method()+' '+new URL(request.url()).pathname);if(request.url().includes('/proxy/api/structured/sessions/'+sessionId)&&!request.url().includes('/ws')&&request.method()==='GET')historyRequests.push(request.url());});
    await page.route('**/api/**',async route=>{if(!['GET','HEAD','OPTIONS'].includes(route.request().method())){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Synthetic browser mutation guard'})});}else await route.continue();});
    if(mode==='revoked')await page.route('**/api/environments/'+environment.id+'/proxy/api/structured/sessions/'+sessionId,async route=>{
     const grants=await request(target,'GET','/api/environments');
     await request(target,'DELETE','/api/environments/grants/'+grants.grants[0].id);
     await route.continue();
    });
    await page.goto(origin+'/relay-recovery.html');
    if(mode.startsWith('controller-')){
     const draft=page.getByRole('textbox',{name:'Command composer'});
     const recovery=page.getByRole('status',{name:'Connection recovery'});
     await expect(recovery).toContainText('Saved history loaded; live updates are paused',{timeout:30000});
     await expect(recovery).toBeInViewport();
     await expect(draft).toBeEnabled();await draft.fill('Retained real browser controller draft');
     const before=await page.evaluate(()=>window.readComposerDraft());
     await expect(page.getByRole('button',{name:mode==='controller-desktop'?'Send message':'Send to terminal',exact:true})).toBeDisabled();
     await draft.press(mode==='controller-mobile'?'Control+Enter':'Enter');await delay(200);
     const after=await page.evaluate(()=>window.readComposerDraft());
     expect({text:after.text,revision:after.revision,pending:after.pending}).toEqual({text:before.text,revision:before.revision,pending:before.pending});
     await draft.fill('Edited in history-only mode');expect(await page.evaluate(()=>window.readComposerDraft().text)).toBe('Edited in history-only mode');
     await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));});await delay(2200);
     const result=await page.evaluate(()=>({attempts:window.socketAttempts,closes:window.socketCloses,draft:window.readComposerDraft().text}));
     expect(result.attempts).toBe(1);expect(historyRequests).toHaveLength(1);expect(mutations).toEqual([]);expect(errors).toEqual([]);
     await page.screenshot({path:path.join(root,mode+'.png')});
     evidence.push({mode,...result,historyRequests:historyRequests.length,pageErrors:errors,screenshot:path.join(root,mode+'.png'),ports:hosts.map(host=>new URL(host.url).port)});
     if(process.env.E2E_RELAY_EVIDENCE)await writeFile(process.env.E2E_RELAY_EVIDENCE,JSON.stringify({root,binary:apiBinary,binarySha256,startedAt,evidence},null,2));
     continue;
    }
    if(mode==='revoked'){
     await expect.poll(()=>page.getByRole('alert').textContent()).toMatch(/Could not load saved history/);
     expect(await page.getByTestId('length').textContent()).toBe('7');
     await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));});await delay(2200);
     const result=await page.evaluate(()=>({attempts:window.socketAttempts,closes:window.socketCloses,ids:window.relayState.messages.map(m=>m.messageId)}));
     expect(result.attempts).toBe(1);expect(result.ids).toEqual(['first']);expect(historyRequests).toHaveLength(1);expect(mutations).toEqual([]);expect(errors).toEqual([]);
     evidence.push({mode,...result,historyRequests:historyRequests.length,pageErrors:errors,ports:hosts.map(host=>new URL(host.url).port)});
     if(process.env.E2E_RELAY_EVIDENCE)await writeFile(process.env.E2E_RELAY_EVIDENCE,JSON.stringify({root,binary:apiBinary,binarySha256,startedAt,evidence},null,2));
     continue;
    }
    await expect.poll(async()=>Number(await page.getByTestId('length').textContent()),{timeout:30000}).toBe(7+content.length);
    if(mode==='upgraded'){expect(await page.getByTestId('connection').textContent()).toBe('online');expect(await page.getByRole('alert').textContent()).toBe('');}
    else {await expect.poll(()=>page.getByRole('alert').textContent()).toMatch(/Saved history loaded; live updates are paused/);expect(await page.getByTestId('connection').textContent()).toBe('unavailable');}
    const result=await page.evaluate(async()=>{const state=window.relayState;const text=state.messages.map(m=>m.content).join('');return {attempts:window.socketAttempts,closes:window.socketCloses,ids:state.messages.map(m=>m.messageId),seqs:state.messages.map(m=>m.seq),sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('')};});
    expect(result.sha256).toBe(createHash('sha256').update('prefix|'+content).digest('hex'));expect(result.ids).toEqual(['first','large']);expect(result.seqs).toEqual([1,2]);
    await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));});await delay(2200);
    expect(await page.evaluate(()=>window.socketAttempts)).toBe(1);expect(historyRequests).toHaveLength(mode==='upgraded'?0:1);expect(mutations).toEqual([]);expect(errors).toEqual([]);
    if(mode!=='upgraded')expect(result.closes).toEqual([expect.objectContaining({code:1009,reason:expect.stringContaining('Relay message limit exceeded')})]);
    evidence.push({mode,contentBytes:Buffer.byteLength(content),...result,historyRequests:historyRequests.length,pageErrors:errors,ports:hosts.map(host=>new URL(host.url).port)});
    if(process.env.E2E_RELAY_EVIDENCE)await writeFile(process.env.E2E_RELAY_EVIDENCE,JSON.stringify({root,binary:apiBinary,binarySha256,startedAt,evidence},null,2));
   }finally{await context?.close();await vite?.close();for(const host of hosts.reverse())await stopHost(host);await shim?.close();}
  }
 }finally{await browser.close();}
 const binaryEndSha256=createHash('sha256').update(await readFile(apiBinary)).digest('hex');expect(binaryEndSha256).toBe(binarySha256);
 if(process.env.E2E_RELAY_EVIDENCE)await writeFile(process.env.E2E_RELAY_EVIDENCE,JSON.stringify({root,binary:apiBinary,binarySha256,binaryEndSha256,startedAt,finishedAt:new Date().toISOString(),evidence},null,2));
});
