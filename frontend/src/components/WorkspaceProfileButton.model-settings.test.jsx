import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));

const workspacePath = '/synthetic/project';
const profileUrl = '/api/workspace/profile?path=' + encodeURIComponent(workspacePath);
const profile = {
  memory: 'Run focused tests.', skills: [], defaultAgent: 'codex',
  selection: { model: 'model-one', reasoning: 'high' },
};
const catalog = { agents: [{
  id: 'codex', label: 'Codex', runtime: 'codex', status: 'ready', available: true,
  models: [{ id: 'model-one', label: 'Model One', default: true }, { id: 'model-two', label: 'Model Two' }],
  reasoningLevels: ['low', 'high'],
}] };

describe('WorkspaceProfileButton model defaults', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (url, options) => ({
      ok: true,
      json: async () => url === '/api/agent/catalog' ? catalog : options?.method === 'PUT' ? options.body : profile,
    }));
  });

  it('offers only supported workspace defaults', async () => {
    render(<WorkspaceProfileButton workspacePath={workspacePath} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    const modelTrigger = await screen.findByRole('button', { name: 'Codex model Model One' });
    expect(modelTrigger).toHaveAttribute('title', 'Model and reasoning');
    fireEvent.click(modelTrigger);

    expect(screen.queryByRole('button', { name: /^Speed:/ })).not.toBeInTheDocument();
  });

  it('saves deliberate model and reasoning changes without unsupported selection fields', async () => {
    const onSaved = vi.fn();
    render(<WorkspaceProfileButton workspacePath={workspacePath} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Codex model Model One' }));
    fireEvent.click(screen.getByRole('option', { name: 'Model Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(screen.getByRole('button', { name: 'Reasoning: Low' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));

    const expected = { ...profile, selection: { model: 'model-two', reasoning: 'low' } };
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expected));
    expect(apiFetch).toHaveBeenLastCalledWith(profileUrl, { method: 'PUT', body: expected });
  });
});
