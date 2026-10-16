import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceProposalsPanel } from './WorkspaceProposalsPanel';
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const workspacePath = '/projects/example';
const profile = { memory: 'Use Rust.', skills: [], defaultAgent: '', selection: null };
const proposal = { id: '00000000-0000-4000-8000-000000000001', title: 'Test command', reason: 'Verified in this task', operations: [{ kind: 'memoryAppend', content: 'Run cargo test.' }], status: 'pending', createdAt: 100 };
const response = payload => ({ ok: true, json: async () => payload });

describe('WorkspaceProposalsPanel', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async url => response(url.includes('/profile') ? profile : { proposals: [proposal] }));
  });
  it('previews staged changes and persists explicit acceptance before notifying profile changes', async () => {
    const onProfileChanged = vi.fn();
    const nextProfile = { ...profile, memory: 'Use Rust.\n\nRun cargo test.' };
    apiFetch.mockImplementation(async (url, options) => response(options?.method === 'POST'
      ? { proposal: { ...proposal, status: 'accepted' }, profile: nextProfile }
      : url.includes('/profile') ? profile : { proposals: [proposal] }));
    render(<WorkspaceProposalsPanel workspacePath={workspacePath} onProfileChanged={onProfileChanged} />);
    expect(await screen.findByText('Run cargo test.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Test command' }));
    await waitFor(() => expect(onProfileChanged).toHaveBeenCalledWith(nextProfile));
    expect(apiFetch).toHaveBeenCalledWith('/api/workspace/proposals/' + proposal.id + '/accept?path=' + encodeURIComponent(workspacePath), { method: 'POST' });
  });
  it('keeps rejected or failed suggestions separate from saved knowledge', async () => {
    apiFetch.mockImplementation(async (url, options) => options?.method === 'POST'
      ? { ok: false, json: async () => ({ error: 'The saved entry changed. Request a new proposal.' }) }
      : response(url.includes('/profile') ? profile : { proposals: [proposal] }));
    render(<WorkspaceProposalsPanel workspacePath={workspacePath} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Test command' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The saved entry changed.');
    expect(screen.getByRole('button', { name: 'Reject Test command' })).toBeEnabled();
  });
  it('requires a matching real agent response and an explicit stage action', async () => {
    const onRequestSuggestions = vi.fn();
    const { rerender } = render(<WorkspaceProposalsPanel workspacePath={workspacePath} onRequestSuggestions={onRequestSuggestions} latestAssistantText="Unrelated answer" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare learning request' }));
    expect(onRequestSuggestions).toHaveBeenCalledTimes(1);
    const request = JSON.parse(onRequestSuggestions.mock.calls[0][0].match(/\{"type":"terminal-workspace-proposal".*\}/)[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent proposal' }));
    expect(screen.getByRole('alert')).toHaveTextContent('complete JSON');
    const envelope = { type: 'terminal-workspace-proposal', version: 1, requestId: request.requestId, title: 'New knowledge', reason: 'Verified', operations: proposal.operations };
    rerender(<WorkspaceProposalsPanel workspacePath={workspacePath} onRequestSuggestions={onRequestSuggestions} latestAssistantText={JSON.stringify(envelope)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview agent proposal' }));
    expect(screen.getByRole('button', { name: 'Stage for review' })).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => options?.body?.title === 'New knowledge')).toBe(true));
  });
});
