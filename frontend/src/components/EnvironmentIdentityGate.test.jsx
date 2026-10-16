import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentIdentityGate } from './EnvironmentIdentityGate';
import { getActiveEnvironment, setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
const { apiFetch }=vi.hoisted(()=>({apiFetch:vi.fn()}));
vi.mock('../utils/api',()=>({apiFetch}));
function pending(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{localStorage.clear();setEnvironmentIdentity(null);apiFetch.mockReset();});
afterEach(()=>{cleanup();setEnvironmentIdentity(null);});
describe('EnvironmentIdentityGate',()=>{
 it('waits for the authenticated home directory before mounting a remembered remote workspace',async()=>{
  setEnvironmentIdentity('owner');setActiveEnvironment({id:'remote',label:'Remembered'});setEnvironmentIdentity(null);const result=pending();apiFetch.mockReturnValue(result.promise);
  render(<EnvironmentIdentityGate userId="owner"><p>Workspace mounted</p></EnvironmentIdentityGate>);expect(screen.queryByText('Workspace mounted')).toBeNull();
  await act(async()=>result.resolve({ok:true,json:async()=>({environments:[{id:'remote',label:'Verified'}]})}));
  await screen.findByText('Workspace mounted');expect(getActiveEnvironment()).toEqual({id:'remote',label:'Verified'});expect(apiFetch).toHaveBeenCalledWith('/api/environments',expect.objectContaining({home:true}));
 });
 it('ignores an earlier owner directory response after the signed-in owner changes',async()=>{
  const first=pending(),second=pending();apiFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const {rerender}=render(<EnvironmentIdentityGate userId="first">First workspace</EnvironmentIdentityGate>);
  rerender(<EnvironmentIdentityGate userId="second">Second workspace</EnvironmentIdentityGate>);
  await act(async()=>second.resolve({ok:true,json:async()=>({environments:[]})}));await screen.findByText('Second workspace');
  await act(async()=>first.resolve({ok:true,json:async()=>({environments:[{id:'wrong-owner'}]})}));expect(getActiveEnvironment()).toBeNull();expect(screen.queryByText('First workspace')).toBeNull();
 });
 it('makes the home workspace available with a visible directory error when validation fails',async()=>{
  apiFetch.mockRejectedValue(new Error('Directory offline'));render(<EnvironmentIdentityGate userId="owner">Home workspace</EnvironmentIdentityGate>);
  await screen.findByText('Home workspace');expect(screen.getByRole('alert').textContent).toContain('Directory offline');expect(getActiveEnvironment()).toBeNull();
 });
});
