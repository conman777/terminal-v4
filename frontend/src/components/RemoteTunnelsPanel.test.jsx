import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import RemoteTunnelsPanel from './RemoteTunnelsPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const reply = data => ({ ok: true, json: async () => data });
beforeEach(() => apiFetch.mockImplementation(async path => reply(path === '/api/environments' ? { environments: [{id:'host',label:'Build host',capabilities:{tunnels:true}}] } : { tunnels: [] })));
it('creates a loopback forward on the home server with explicit target', async () => {
 render(<RemoteTunnelsPanel />);
 fireEvent.change(await screen.findByLabelText('Tunnel device'), {target:{value:'host'}});
 fireEvent.change(screen.getByLabelText('Remote service port'), {target:{value:'5432'}});
 fireEvent.click(screen.getByRole('button',{name:'Start service tunnel'}));
 await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/tunnels',expect.objectContaining({home:true,method:'POST',body:{environmentId:'host',targetPort:5432}})));
 expect(screen.getByText(/home API computer/)).toBeInTheDocument();
});
it('displays active local endpoints and stops only the chosen listener',async()=>{
 apiFetch.mockImplementation(async path=>reply(path==='/api/environments'?{environments:[]}:{tunnels:[{id:'tunnel-a',environmentId:'host',localPort:45123,targetPort:5432}]}));
 render(<RemoteTunnelsPanel />);
 expect(await screen.findByText('127.0.0.1:45123')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Stop tunnel 45123'}));
 await waitFor(()=>expect(apiFetch).toHaveBeenCalledWith('/api/tunnels/tunnel-a',{home:true,method:'DELETE'}));
});
