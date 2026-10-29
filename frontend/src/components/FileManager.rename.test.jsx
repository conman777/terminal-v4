import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FileManager} from './FileManager';
import {apiFetch,apiGet} from '../utils/api';
import {setActiveEnvironment} from '../utils/remoteEnvironments';
vi.mock('../utils/api',()=>({apiGet:vi.fn(),apiFetch:vi.fn()}));
vi.mock('../utils/auth', async importOriginal => ({ ...await importOriginal(), getAccessToken: () => null }));
const path='/synthetic/workspace';
let files;
beforeEach(()=>{files=[{name:'source.txt',type:'file',size:7},{name:'existing.txt',type:'file',size:8},{name:'folder',type:'directory'}];apiGet.mockReset().mockImplementation(async()=>({path,items:files}));apiFetch.mockReset();});
afterEach(()=>setActiveEnvironment(null));
async function openRename(name='source.txt'){render(<FileManager isOpen initialPath={path} onClose={vi.fn()}/>);const more=await screen.findByRole('button',{name:'More actions for '+name});fireEvent.click(more);fireEvent.click(screen.getByRole('menuitem',{name:'Rename'}));return more;}

describe('Files rename',()=>{
 it('uses the browsed source and destination, retains an HTTP failure for editing and retry, and confirms success',async()=>{
  apiFetch.mockResolvedValueOnce({ok:false,json:async()=>({error:'Synthetic rename denied'})}).mockImplementationOnce(async()=>{files=files.map(f=>f.name==='source.txt'?{...f,name:'renamed.txt'}:f);return {ok:true,status:204};});
  await openRename();const name=screen.getByRole('textbox',{name:'New name'});expect(name).toHaveFocus();
  fireEvent.change(name,{target:{value:'renamed.txt'}});fireEvent.click(screen.getByRole('button',{name:'Rename',exact:true}));
  await screen.findByText('Synthetic rename denied');expect(name).toHaveValue('renamed.txt');expect(name).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Rename',exact:true}));
  expect(await screen.findByRole('button',{name:'Select file renamed.txt'})).toBeInTheDocument();
  expect(apiFetch.mock.calls).toEqual([['/api/files/rename',{method:'POST',body:{from:path+'/source.txt',to:path+'/renamed.txt'}}],['/api/files/rename',{method:'POST',body:{from:path+'/source.txt',to:path+'/renamed.txt'}}]]);
  expect(screen.getByRole('searchbox',{name:'Search files'})).toHaveFocus();expect(screen.getByRole('status')).toHaveTextContent('Renamed source.txt to renamed.txt');
 });
 it.each(['../moved.txt','nested/moved.txt','existing.txt'])('rejects unsafe or conflicting rename %s without sending a mutation',async target=>{
  await openRename();fireEvent.change(screen.getByLabelText('New name'),{target:{value:target}});fireEvent.click(screen.getByRole('button',{name:'Rename',exact:true}));
  expect(screen.getByRole('alert')).toBeInTheDocument();expect(screen.getByLabelText('New name')).toHaveValue(target);expect(apiFetch).not.toHaveBeenCalled();
 });
 it('renames folders through the same API contract and cancels a draft with focus restoration',async()=>{
  const more=await openRename('folder');fireEvent.change(screen.getByLabelText('New name'),{target:{value:'next-folder'}});fireEvent.keyDown(screen.getByLabelText('New name'),{key:'Escape'});
  expect(screen.queryByRole('textbox',{name:'New name'})).not.toBeInTheDocument();expect(more).toHaveFocus();expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(more);fireEvent.click(screen.getByRole('menuitem',{name:'Rename'}));fireEvent.change(screen.getByLabelText('New name'),{target:{value:'next-folder'}});apiFetch.mockResolvedValue({ok:true});fireEvent.click(screen.getByRole('button',{name:'Rename',exact:true}));
  await waitFor(()=>expect(apiFetch).toHaveBeenCalledWith('/api/files/rename',{method:'POST',body:{from:path+'/folder',to:path+'/next-folder'}}));
 });
 it('gates Rename when the selected server allows browsing without file changes',async()=>{
  setActiveEnvironment({id:'synthetic-observer',label:'Read-only fixture',capabilities:{fileWrite:false}});
  render(<FileManager isOpen initialPath={path} onClose={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'More actions for source.txt'}));
  expect(screen.getByRole('menuitem',{name:'Rename'})).toBeDisabled();expect(screen.getByText(/File changes are not allowed/)).toBeInTheDocument();expect(apiFetch).not.toHaveBeenCalled();
 });
 it('closes the action menu with Escape and returns focus to its row trigger',async()=>{
  render(<FileManager isOpen initialPath={path} onClose={vi.fn()}/>);const more=await screen.findByRole('button',{name:'More actions for source.txt'});fireEvent.click(more);const rename=screen.getByRole('menuitem',{name:'Rename'});expect(rename).toHaveFocus();fireEvent.keyDown(rename,{key:'ArrowDown'});expect(screen.getByRole('menuitem',{name:'Delete'})).toHaveFocus();fireEvent.keyDown(document.activeElement,{key:'Escape'});expect(more).toHaveFocus();expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 });
});

it('preserves later folder navigation when an earlier rename response completes',async()=>{
 let finish;
 apiGet.mockImplementation(async url=>{const selected=new URL(url,'http://fixture.invalid').searchParams.get('path');return {path:selected,items:files};});
 apiFetch.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({ok:true,status:204});}));
 await openRename();fireEvent.change(screen.getByLabelText('New name'),{target:{value:'renamed-later.txt'}});fireEvent.click(screen.getByRole('button',{name:'Rename',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'Open folder folder'}));
 await waitFor(()=>expect(screen.getByRole('navigation',{name:'File path'}).querySelector('[aria-current="location"]')).toHaveTextContent('folder'));
 await act(async()=>finish());
 expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=%2Fsynthetic%2Fworkspace%2Ffolder');
 expect(screen.queryByText(/Renamed source.txt to/)).not.toBeInTheDocument();
 expect(screen.queryByRole('textbox',{name:'New name'})).not.toBeInTheDocument();
});
