import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollaborationPanel } from './CollaborationPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
beforeEach(() => apiFetch.mockImplementation(async (url, options) => ({ ok: true, status: 200, json: async () => options?.method === 'POST' ? { id: 'invitation', secret: 'one-use-secret', expiresAt: 2000000000 } : { invitations: [{ id: 'existing', sessionId: 'terminal-a', role: 'observer', expiresAt: 2000000000, maxUses: 1, uses: 1, participants: [{ id: 'guest-a', displayName: 'Pat', lastSeenAt: 1700000000 }] }] } })));
describe('CollaborationPanel', () => {
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
