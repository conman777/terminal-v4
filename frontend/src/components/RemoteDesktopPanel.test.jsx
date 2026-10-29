import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RemoteDesktopPanel from './RemoteDesktopPanel';
import { apiFetch } from '../utils/api';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({apiFetch: vi.fn()}));
const response = data => ({ok:true,json:async()=>data});
describe('RemoteDesktopPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); setActiveEnvironment(null); URL.createObjectURL = vi.fn(() => 'blob:desktop-fixture'); URL.revokeObjectURL = vi.fn(); });
  it('explains host opt-in without starting capture', async () => {
    apiFetch.mockResolvedValue(response({enabled:false,available:false,message:'Desktop access is disabled on this host.',monitors:[]}));
    render(<RemoteDesktopPanel />);
    expect(await screen.findByText('Desktop access is disabled on this host.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button',{name:'Start viewing'})).not.toBeInTheDocument();
  });
  it('stays out of the way on hosts that cannot share their desktop', async () => {
    apiFetch.mockResolvedValue(response({enabled:false,available:false,platform:'macos',message:'Desktop viewing currently requires an interactive Windows host.',monitors:[]}));
    const { container } = render(<RemoteDesktopPanel />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
  it('requires explicit viewing and never offers control on a view-only host', async () => {
    apiFetch.mockResolvedValue(response({enabled:true,available:true,control:false,monitors:[{id:'display',label:'Display 1',width:1920,height:1080}]}));
    render(<RemoteDesktopPanel />);
    await screen.findByRole('button',{name:'Start viewing'});
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Enable remote keyboard and pointer control')).not.toBeInTheDocument();
  });
  it('aborts a remote stream and stops its original session on a host switch', async () => {
    const remote = {id:'remote-device',label:'Work PC',capabilities:{desktopView:true,desktopControl:false}};
    setActiveEnvironment(remote);
    const status={enabled:true,available:true,control:false,monitors:[{id:'display',label:'Display',width:1920,height:1080}]};
    let frameSignal;
    apiFetch.mockImplementation((path, options) => {
      if (path.endsWith('/status')) return Promise.resolve(response(status));
      if (path.endsWith('/sessions') && options.method==='POST') return Promise.resolve(response({id:'desktop-session',expiresAt:2000000000}));
      if (path.endsWith('/frame')) { frameSignal=options.signal; return new Promise((_, reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))); }
      return Promise.resolve({ok:true,status:204});
    });
    render(<RemoteDesktopPanel />);
    fireEvent.click(await screen.findByRole('button',{name:'Start viewing'}));
    await waitFor(()=>expect(frameSignal).toBeDefined());
    expect(screen.queryByLabelText('Enable remote keyboard and pointer control')).not.toBeInTheDocument();
    act(()=>setActiveEnvironment(null));
    await screen.findByText('Desktop · This host');
    expect(frameSignal.aborted).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/environments/remote-device/proxy/api/desktop/sessions/desktop-session',expect.objectContaining({method:'DELETE',home:true}));
    expect(screen.queryByAltText('Live remote Windows desktop')).not.toBeInTheDocument();
  });
  it('shows failures without pretending a desktop is available', async () => {
    apiFetch.mockRejectedValue(new Error('Desktop viewing permission is required'));
    render(<RemoteDesktopPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Desktop viewing permission is required');
  });
});
