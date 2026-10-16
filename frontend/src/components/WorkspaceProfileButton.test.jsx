import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
vi.mock('./AgentModelPicker', () => ({ AgentModelPicker: () => <div>Model picker</div> }));

const path = '/projects/example';
const url = '/api/workspace/profile?path=' + encodeURIComponent(path);
const profile = {
  memory: 'Use Rust for API changes.',
  skills: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Review', instructions: 'Check error boundaries.' }],
  defaultAgent: 'codex',
  selection: { model: 'model-one', reasoning: 'high' },
};

describe('WorkspaceProfileButton', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => profile });
  });

  it('loads saved workspace notes and inserts only chosen context for review', async () => {
    const onInsertContext = vi.fn();
    render(<WorkspaceProfileButton workspacePath={path} onInsertContext={onInsertContext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    expect(await screen.findByLabelText('Project knowledge')).toHaveValue(profile.memory);
    fireEvent.click(screen.getByLabelText('Include Review'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(onInsertContext).toHaveBeenCalledWith('Workspace knowledge:\nUse Rust for API changes.\n\nSkill: Review\nCheck error boundaries.');
    expect(apiFetch.mock.calls).toEqual([[url, { signal: expect.any(AbortSignal) }]]);
  });

  it('persists edited knowledge and defaults through the authenticated API', async () => {
    const onSaved = vi.fn();
    render(<WorkspaceProfileButton workspacePath={path} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    fireEvent.change(await screen.findByLabelText('Project knowledge'), { target: { value: 'Run cargo test.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenLastCalledWith(url, {
      method: 'PUT',
      body: { ...profile, memory: 'Run cargo test.' },
    });
  });

  it('keeps unsaved edits available after a failed save', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'PUT'
      ? { ok: false, json: async () => ({ error: 'Unable to save workspace' }) }
      : { ok: true, json: async () => profile });
    render(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    fireEvent.change(await screen.findByLabelText('Project knowledge'), { target: { value: 'Keep these notes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save workspace');
    expect(screen.getByLabelText('Project knowledge')).toHaveValue('Keep these notes.');
  });

  it('refuses to edit when loading the existing profile fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Profile unreadable' }) });
    render(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Profile unreadable');
    expect(screen.queryByRole('button', { name: 'Save workspace' })).not.toBeInTheDocument();
  });

  it('disables opening without a workspace and closes on Escape', async () => {
    const { rerender } = render(<WorkspaceProfileButton workspacePath="" />);
    expect(screen.getByRole('button', { name: 'Workspace knowledge' })).toBeDisabled();
    rerender(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    await screen.findByLabelText('Project knowledge');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
