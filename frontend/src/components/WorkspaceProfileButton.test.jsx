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
  it('isolates the knowledge dialog from the workspace and restores its trigger on close', async () => {
    render(<div id="root"><WorkspaceProfileButton workspacePath={path} /></div>);
    const root = document.getElementById('root');
    const previous = root.inert;
    const trigger = screen.getByRole('button', { name: 'Workspace knowledge' });
    fireEvent.click(trigger);
    await screen.findByLabelText('Project knowledge');
    expect(root.inert).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace knowledge' }));
    expect(root.inert).toBe(previous);
    expect(trigger).toHaveFocus();
  });

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

  it('exports knowledge to a file and imports it back for review before saving', async () => {
    const exported = [];
    URL.createObjectURL = vi.fn(blob => { exported.push(blob); return 'blob:knowledge'; });
    URL.revokeObjectURL = vi.fn();
    render(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    await screen.findByLabelText('Project knowledge');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const file = new File([JSON.stringify({ ...profile, memory: 'Imported notes.' })], 'knowledge.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Import knowledge file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Project knowledge')).toHaveValue('Imported notes.'));
    const exportedText = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported[0]); });
    expect([JSON.parse(exportedText), screen.getByText('Unsaved changes') !== null, apiFetch.mock.calls.length]).toEqual([profile, true, 1]);
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

describe('owned skill package editing', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ...profile, skills: [{ ...profile.skills[0], supportFiles: { 'references/review.md': 'Original checklist.' } }] }) });
  });
  it('saves an explicit on-demand choice and preserves the selected package in the prompt', async () => {
    const onInsertContext = vi.fn();
    render(<WorkspaceProfileButton workspacePath={path} onInsertContext={onInsertContext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    fireEvent.change(await screen.findByLabelText('When to use Review'), { target: { value: 'onDemand' } });
    expect(screen.getByText(/V4 can read the instructions when relevant or requested/)).toBeInTheDocument();
    expect(screen.queryByText(/until then V4 includes saved instructions/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body.skills[0]).toEqual({ ...profile.skills[0], activation: 'onDemand', supportFiles: { 'references/review.md': 'Original checklist.' } }));
    fireEvent.click(screen.getByLabelText('Include Review'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(onInsertContext).toHaveBeenCalledWith('Workspace knowledge:\nUse Rust for API changes.\n\nSkill: Review\nCheck error boundaries.\nSupporting file: references/review.md\nOriginal checklist.');
  });
  it('edits support files and preserves them during a manual save', async () => {
    render(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    fireEvent.change(await screen.findByLabelText('Contents of references/review.md'), { target: { value: 'New checklist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith(url, { method: 'PUT', body: { ...profile, skills: [{ ...profile.skills[0], supportFiles: { 'references/review.md': 'New checklist.' } }] } }));
  });
  it('imports an owned package, previews all its files, and saves only after review', async () => {
    render(<WorkspaceProfileButton workspacePath={path} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    const imported = { id: '00000000-0000-4000-8000-000000000002', name: 'Ship', instructions: 'Use release instructions.', supportFiles: { 'references/release.md': 'Run gates.' } };
    fireEvent.change(await screen.findByLabelText('Skill package JSON'), { target: { value: JSON.stringify(imported) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import skill package' }));
    expect(screen.getByLabelText('Contents of references/release.md')).toHaveValue('Run gates.');
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body.skills).toContainEqual(imported));
  });
});
