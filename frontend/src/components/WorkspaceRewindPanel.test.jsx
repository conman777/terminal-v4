import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceRewindPanel } from './WorkspaceRewindPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
let listing;
const reply = data => ({ ok: true, json: async () => data });
beforeEach(() => {
  listing = { managed: true, conversations: [{ sourceId: 'source-a', provider: 'codex', title: 'Implement parser', turns: [{ id: 'turn-a', ordinal: 0, prompt: 'Create parser', supported: true }, { id: 'turn-b', ordinal: 1, prompt: 'Unsupported target', supported: false, reason: 'Missing durable turn boundary' }] }], checkpoints: [{ id: 'checkpoint-a', label: 'Before parser' }], activeSessions: [{ id: 'terminal-a', title: 'Live agent' }], operations: [] };
  apiFetch.mockImplementation(async (url, options) => {
    if (url.includes('/plan')) return reply({ id: 'operation-a', status: 'planned', sourceId: 'source-a', targetTurnId: 'turn-a', checkpointId: 'checkpoint-a' });
    if (url.includes('/apply')) return reply({ id: 'operation-a', status: 'applied', recoveryCheckpointId: 'recovery-a', nativeFork: { sessionId: 'native-a' } });
    if (url.includes('/resume')) return reply({ operation: { id: 'operation-a', status: 'resumed' }, session: { id: 'resumed-session' } });
    if (url.includes('/recover')) return reply({ id: 'failed-a', status: 'recovered', recoveryCheckpointId: 'recovery-a' });
    if (options?.method === 'POST') return reply({});
    return reply(listing);
  });
});
describe('WorkspaceRewindPanel', () => {
  it('previews the exact native turn and files checkpoint before applying, then opens the resumed session', async () => {
    const onSelectSession = vi.fn();
    render(<WorkspaceRewindPanel workspacePath="/managed" onSelectSession={onSelectSession} />);
    await screen.findByRole('option', { name: /Implement parser/ });
    fireEvent.change(screen.getByLabelText('Native conversation'), { target: { value: 'source-a' } });
    fireEvent.change(screen.getByLabelText('Rewind before user turn'), { target: { value: 'turn-a' } });
    fireEvent.change(screen.getByLabelText('Files checkpoint'), { target: { value: 'checkpoint-a' } });
    expect(screen.queryByRole('button', { name: 'Apply rewind' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review rewind plan' }));
    expect(await screen.findByText(/Original conversation stays available/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/api/workspace/rewind/plan', expect.objectContaining({ method: 'POST', body: { path: '/managed', sourceId: 'source-a', targetTurnId: 'turn-a', checkpointId: 'checkpoint-a' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply rewind' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open resumed conversation' }));
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('resumed-session'));
  });
  it('disables unsupported native targets and requires a managed worktree', async () => {
    listing.managed = false;
    render(<WorkspaceRewindPanel workspacePath="/project" />);
    expect(await screen.findByText(/Create an isolated worktree/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Native conversation'), { target: { value: 'source-a' } });
    expect(screen.getByRole('option', { name: /Unsupported target/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review rewind plan' })).toBeDisabled();
  });
  it('suspends a live session without deleting its saved conversation and offers recovery for interrupted operations', async () => {
    listing.operations = [{ id: 'failed-a', status: 'failed', recoveryCheckpointId: 'recovery-a', error: 'Native fork failed' }];
    render(<WorkspaceRewindPanel workspacePath="/managed" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend Live agent' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/rewind/suspend', expect.objectContaining({ method: 'POST', body: { path: '/managed', sessionId: 'terminal-a' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Recover files for failed-a' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/rewind/failed-a/recover', expect.objectContaining({ method: 'POST', body: { path: '/managed' } })));
  });
  it('offers file recovery for a branch creation interrupted before checkpoint restoration', async () => {
    listing.operations = [{ id: 'interrupted-a', status: 'branchCreated', recoveryCheckpointId: 'recovery-a' }];
    render(<WorkspaceRewindPanel workspacePath="/managed" />);
    expect(await screen.findByRole('button', { name: 'Recover files for interrupted-a' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Open resumed conversation' })).not.toBeInTheDocument();
  });

});
