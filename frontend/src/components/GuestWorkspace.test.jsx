import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GuestWorkspace, hasGuestInvitation } from './GuestWorkspace';
const terminals=vi.hoisted(()=>[]);
vi.mock('@xterm/xterm',()=>({Terminal:class { constructor(options){this.options=options;this.write=vi.fn((_text,done)=>done?.());this.open=vi.fn();this.loadAddon=vi.fn();this.reset=vi.fn();this.dispose=vi.fn();terminals.push(this);} }}));
vi.mock('@xterm/addon-fit',()=>({FitAddon:class {fit=vi.fn();}}));
const sockets = [];
class Socket {
 static OPEN=1;
 constructor(url) { this.readyState=0; this.url = url; sockets.push(this); }
 send = vi.fn(); close = vi.fn();
}
beforeEach(() => {
 history.replaceState(null, '', '/#invite=invitation.secret');
 sockets.length = 0; terminals.length=0; vi.stubGlobal('WebSocket', Socket);
 vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ credential: 'guest-only', sessionId: 'terminal-a', role: 'observer', expiresAt: 2000000000 }) })));
});
describe('GuestWorkspace', () => {
 it('exchanges the fragment secret without owner auth, clears the URL and offers observers no input', async () => {
  expect(hasGuestInvitation()).toBe(true);
  render(<GuestWorkspace />);
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Pat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/collaboration/guest/exchange'), expect.objectContaining({ body: JSON.stringify({ id: 'invitation', secret: 'secret', displayName: 'Pat' }) }));
  expect(location.hash).toBe('');
  expect(sockets[0].url).not.toContain('secret');
  sockets[0].readyState=Socket.OPEN; sockets[0].onopen();
  expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth', credential: 'guest-only' }));
  expect(screen.queryByRole('button', { name: 'Send input' })).not.toBeInTheDocument();
 });
 it('renders received terminal output as text', async () => {
  render(<GuestWorkspace />); fireEvent.click(screen.getByRole('button', { name: 'Join terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0].onmessage({ data: JSON.stringify({ type: 'output', text: '<script>alert(1)</script>' }) });
  await waitFor(()=>expect(terminals[0]?.write).toHaveBeenCalledWith('<script>alert(1)</script>',expect.any(Function)));
  expect(document.querySelector('.guest-workspace script')).toBeNull();
 });
 it('limits controller input to its dedicated socket and keeps revoked users in the guest view', async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ credential: 'controller-only', sessionId: 'terminal-a', role: 'controller', expiresAt: 2000000000 }) });
  render(<GuestWorkspace />); fireEvent.click(screen.getByRole('button', { name: 'Join terminal' }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0].readyState=Socket.OPEN; sockets[0].onopen();
  fireEvent.change(screen.getByLabelText('Terminal input'), { target: { value: 'echo hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send input' }));
  expect(sockets[0].send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', text: 'echo hello\r' }));
  sockets[0].onclose();
  expect(await screen.findByText(/Access may have expired or been revoked/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Join terminal' })).not.toBeInTheDocument();
 });

 it('blocks controller input until its dedicated socket is open', async () => {
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({credential:'controller-only',sessionId:'terminal-a',role:'controller',expiresAt:2000000000})});
  render(<GuestWorkspace />);fireEvent.click(screen.getByRole('button',{name:'Join terminal'}));
  await waitFor(()=>expect(sockets).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('Terminal input'),{target:{value:'echo guarded'}});
  expect(screen.getByRole('button',{name:'Send input'})).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Terminal input').closest('form'));
  expect(sockets[0].send).not.toHaveBeenCalled();
  sockets[0].readyState=Socket.OPEN;sockets[0].onopen();
  expect(await screen.findByRole('button',{name:'Send input'})).toBeEnabled();
 });

 it('renders ANSI terminal output through a read-only terminal and disposes it when leaving the page', async () => {
  const {unmount}=render(<GuestWorkspace />);fireEvent.click(screen.getByRole('button',{name:'Join terminal'}));
  await waitFor(()=>expect(sockets).toHaveLength(1));
  sockets[0].onmessage({data:JSON.stringify({type:'output',text:'\x1b[2J\x1b[31mred output\x1b[0m'})});
  await waitFor(()=>expect(terminals[0]?.write).toHaveBeenCalledWith('\x1b[2J\x1b[31mred output\x1b[0m',expect.any(Function)));
  expect(terminals[0].options.disableStdin).toBe(true);
  const terminal=terminals[0];unmount();
  expect(terminal.dispose).toHaveBeenCalledTimes(1);
 });

});
