import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api',()=>({apiFetch:vi.fn(async()=>({ok:true}))}));
afterEach(()=>setActiveEnvironment(null));
function Consumer(){const {setTheme}=useTheme();return <button onClick={()=>setTheme('light')}>Choose light theme</button>;}
describe('ThemeContext',()=>{
 it('persists appearance only to the authenticated home account while a paired device is selected',()=>{
  setActiveEnvironment({id:'remote'});
  render(<ThemeProvider><Consumer /></ThemeProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Choose light theme'}));
  expect(apiFetch).toHaveBeenCalledWith('/api/settings',expect.objectContaining({home:true,method:'PATCH',body:JSON.stringify({theme:'light'})}));
 });
});
