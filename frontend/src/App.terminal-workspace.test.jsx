import {it,expect,vi} from 'vitest';
import {render,fireEvent,screen,waitFor,cleanup} from '@testing-library/react';
import App from './App';
import {installSelectionPaneR1Fixture,R1} from './test/selectionPaneR1Fixture';
import {getEnvironmentStorage} from './utils/remoteEnvironments';
it('selecting another sidebar conversation replaces the focused occupied pane',async()=>{
 const fixture=installSelectionPaneR1Fixture();
 const c={id:'ss-t2-third',topic:'Audit third conversation',text:'Audit third saved draft'};
 const snapshot=item=>({id:item.id,title:item.topic,provider:R1.provider,model:R1.model,runtime:'v4',status:'idle',cwd:R1.cwd,createdAt:'2026-10-17T10:00:00Z',updatedAt:'2026-10-17T10:00:00Z',thread:{topic:item.topic,projectPath:R1.cwd,pinned:false,archived:false},latestSeq:0,statusSeq:0});
 const realFetch=globalThis.fetch;
 vi.stubGlobal('fetch',async(input,options)=>{const url=new URL(String(input),location.href);if(url.pathname.endsWith('/api/structured/sessions')&&url.search==='?view=inventory')return new Response(JSON.stringify([R1.a,R1.b,c].map(snapshot)),{status:200,headers:{'Content-Type':'application/json'}});return realFetch(input,options)});
 const BaseSocket=globalThis.WebSocket;
 class FixtureSocket extends BaseSocket { constructor(url){super(String(url).replace(c.id,R1.a.id));} }
 vi.stubGlobal('WebSocket',FixtureSocket);
 const storage=getEnvironmentStorage();
 storage.setItem('tabOrder',JSON.stringify([R1.a.id,R1.b.id,c.id]));
 storage.setItem('desktops',JSON.stringify({activeDesktopId:'desktop-1',desktops:[{id:'desktop-1',name:'Fixture',ownedSessionIds:[R1.a.id,R1.b.id,c.id],paneLayout:{activePaneId:'pane-a',root:{type:'split',direction:'horizontal',children:[{type:'pane',id:'pane-a',sessionId:R1.a.id},{type:'pane',id:'pane-b',sessionId:R1.b.id}]}}}]}));
 const host=document.createElement('div');document.body.append(host);
 try{
  render(<App/>,{container:host});
  fireEvent.change(await screen.findByLabelText('Username'),{target:{value:R1.username}});
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:R1.password}});
  fireEvent.click(screen.getByRole('button',{name:'Initialize Session'}));
  const row=()=>[...host.querySelectorAll('.threads-session-item')].find(el=>el.querySelector('.threads-session-topic')?.textContent===c.topic);
  await waitFor(()=>expect(row()).toBeInTheDocument());
  await waitFor(()=>expect(screen.getAllByRole('textbox',{name:'Command composer'})).toHaveLength(2));
  fireEvent.click(row());
  await waitFor(()=>expect(row()).toHaveClass('active'));
  await waitFor(()=>expect(screen.getAllByRole('textbox',{name:'Command composer'}).map(el=>el.value)).toEqual(['',R1.b.text]));
  expect(screen.getAllByRole('textbox',{name:'Command composer'}).map(el=>el.value)).toEqual(['',R1.b.text]);
  expect(fixture.sendCalls()).toEqual([]);
 }finally{cleanup();host.remove();fixture.restore()}
});
it('successful polling after initial inventory failure restores selectable terminal panes',async()=>{
 const fixture=installSelectionPaneR1Fixture();
 getEnvironmentStorage().removeItem('tabOrder');
 const realFetch=globalThis.fetch;
 let rejected=false;
 vi.stubGlobal('fetch',async(input,options)=>{const url=new URL(String(input),location.href);if(!rejected&&url.pathname.endsWith('/api/terminal')&&(!options?.method||options.method==='GET')){rejected=true;return new Response(JSON.stringify({error:'Synthetic temporary unavailability'}),{status:503,headers:{'Content-Type':'application/json'}})}return realFetch(input,options)});
 const host=document.createElement('div');document.body.append(host);
 try{
  render(<App/>,{container:host});
  fireEvent.change(await screen.findByLabelText('Username'),{target:{value:R1.username}});
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:R1.password}});
  fireEvent.click(screen.getByRole('button',{name:'Initialize Session'}));
  await waitFor(()=>expect(host.querySelector('.workspace-start-view')).toBeInTheDocument());
  expect(rejected).toBe(true);
  fireEvent(window,new Event('focus'));
  await waitFor(()=>expect(host.querySelectorAll('.threads-session-item')).toHaveLength(2));
  await waitFor(()=>expect(host.querySelectorAll('.split-terminal-pane')).toHaveLength(1));

  // A deliberate public sidebar click still cannot populate the tab order.
  fireEvent.click(host.querySelectorAll('.threads-session-item')[1]);
  await waitFor(()=>expect(host.querySelectorAll('.threads-session-item')[1]).toHaveClass('active'));
  await waitFor(()=>expect(host.querySelectorAll('.split-terminal-pane')).toHaveLength(1));
 }finally{cleanup();host.remove();fixture.restore()}
});