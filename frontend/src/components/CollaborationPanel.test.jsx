import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollaborationPanel } from './CollaborationPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
beforeEach(() => { apiFetch.mockImplementation(async (url, options) => ({ ok: true, status: 200, json: async () => options?.method === 'POST' ? { id: 'invitation', secret: 'one-use-secret', expiresAt: 2000000000 } : { invitations: [{ id: 'existing', sessionId: 'terminal-a', role: 'observer', expiresAt: 2000000000, maxUses: 1, uses: 1, participants: [{ id: 'guest-a', displayName: 'Pat', lastSeenAt: 1700000000 }] }] } })); });
describe('CollaborationPanel', () => {
 it('shows invitation loading before presenting an empty result', async () => {
  let finish;
  apiFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<CollaborationPanel workspacePath="/project" sessionId="terminal-a" />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading invitations');
  expect(screen.queryByText('No invitations for this workspace.')).not.toBeInTheDocument();
  await act(async () => finish({ ok: true, json: async () => ({ invitations: [] }) }));
  expect(screen.getByText('No invitations for this workspace.')).toBeInTheDocument();
 });
 it('issues a scoped invitation and exposes the secret only in its fragment', async () => {
  render(<CollaborationPanel workspacePath="/project" sessionId="terminal-a" />);
  await screen.findByText('Pat');
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
  const link = await screen.findByLabelText('Invitation link');
  expect(link.value).toBe(window.location.origin + '/#invite=invitation.one-use-secret');
  expect(apiFetch).toHaveBeenCalledWith('/api/collaboration/invitations', expect.objectContaining({ home: true, method: 'POST', body: { workspacePath: '/project', sessionId: 'terminal-a', role: 'observer', expiresInSeconds: 3600, maxUses: 1 } }));
 });
 it('requires a selected existing terminal and lets the owner revoke invitations', async () => {
  render(<CollaborationPanel workspacePath="/project" />);
  expect(screen.getByRole('button', { name: 'Create invitation' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke existing' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/collaboration/invitations/existing', expect.objectContaining({ home: true, method: 'DELETE' })));
 });
});

it.each(['ss-structured-fixture','structured:ss-legacy-fixture'])('offers conversation sharing instead of a terminal invitation for %s',async sessionId=>{
 apiFetch.mockReset();
 apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ shares: [], audit: [] }) });
 render(<CollaborationPanel workspacePath="/project" sessionId={sessionId}/>);
 await screen.findByText(/No share links for this conversation/);
 expect(screen.getByRole('button',{name:'Create read-only link'})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'Create invitation'})).not.toBeInTheDocument();
 expect(apiFetch.mock.calls.map(([url])=>url)).toEqual([`/api/structured/sessions/${sessionId.replace(/^structured:/, '')}/shares`]);
 expect(apiFetch.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
});
