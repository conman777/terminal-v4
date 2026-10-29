import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FolderBrowserModal } from './FolderBrowserModal';
import { AgentModelPicker } from './AgentModelPicker';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';
import { loadSavedAgentSelection } from '../utils/agentSelection';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const response = value => ({ ok: true, json: async () => value });
const agents = [
  { id: 'codex', label: 'Codex', runtime: 'codex', models: [{ id: 'codex-default', label: 'Codex default', default: true }] },
  { id: 'deepseek', label: 'DeepSeek', runtime: 'v4', models: [{ id: 'provider-default', label: 'Provider default', default: true }] },
].map(agent => ({ ...agent, available: true, status: 'ready', reasoningLevels: ['high'] }));
const catalog = { agents };
const aiOptions = agents.map(({ id, label }) => ({ id, label }));
const directory = { path: '/synthetic/project', folders: [], parent: '/synthetic' };
const projectSelection = { model: 'project-model', reasoning: 'high' };
const renderFolder = onSelect => render(<FolderBrowserModal isOpen currentPath={directory.path} showAiSelector
  defaultAiOptionId="codex" aiOptions={aiOptions} onClose={vi.fn()} onSelect={onSelect} />);

beforeEach(() => { apiFetch.mockReset(); localStorage.clear(); });

it('launches and persists a custom API model chosen while the agent-switch catalog is pending', async () => {
  apiFetch.mockImplementation(url => Promise.resolve(response(url.startsWith('/api/agent/catalog') ? catalog
    : url.startsWith('/api/workspace/profile') ? { defaultAgent: 'codex', selection: projectSelection } : directory)));
  const onSelect = vi.fn();
  renderFolder(onSelect);
  await screen.findByRole('button', { name: 'Codex model project-model' });
  let finishSwitch;
  apiFetch.mockImplementation(url => url.startsWith('/api/agent/catalog')
    ? new Promise(resolve => { finishSwitch = resolve; }) : Promise.resolve(response(directory)));
  fireEvent.click(screen.getByLabelText('Agent'));
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek model Loading models…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enter custom model ID' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom model ID' }), { target: { value: 'custom/explicit-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
  expect(screen.getByRole('button', { name: 'DeepSeek model custom/explicit-model' })).toBeInTheDocument();
  await act(async () => { finishSwitch(response(catalog)); });
  fireEvent.click(screen.getByRole('button', { name: 'Start thread' }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(directory.path, 'deepseek', 'DeepSeek', {
    model: 'custom/explicit-model', reasoning: '', available: true,
  }));
  expect(loadSavedAgentSelection('deepseek')).toEqual({ model: 'custom/explicit-model', reasoning: '' });
});

it('keeps automatic project defaults guarded by unmounting the picker until defaults finish', async () => {
  const catalogs = [];
  let finishProfile;
  apiFetch.mockImplementation(url => url.startsWith('/api/agent/catalog') ? new Promise(resolve => catalogs.push(resolve))
    : url.startsWith('/api/workspace/profile') ? new Promise(resolve => { finishProfile = resolve; }) : Promise.resolve(response(directory)));
  const onSelect = vi.fn();
  renderFolder(onSelect);
  await screen.findByText('Loading project defaults…');
  expect(screen.queryByRole('button', { name: /model/ })).not.toBeInTheDocument();
  await act(async () => { finishProfile(response({ defaultAgent: 'codex', selection: projectSelection })); });
  await screen.findByRole('button', { name: 'Codex model project-model' });
  await act(async () => { catalogs.forEach(resolve => resolve(response(catalog))); });
  await screen.findByRole('button', { name: 'Codex model project-model' });
  fireEvent.click(screen.getByRole('button', { name: 'Start thread' }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(directory.path, 'codex', '', {
    ...projectSelection, available: true,
  }));
});

it('saves a custom model from the real workspace editor while its agent-switch catalog is pending', async () => {
  const workspace = { memory: '', skills: [], defaultAgent: 'codex', selection: projectSelection };
  apiFetch.mockImplementation(url => Promise.resolve(response(url.startsWith('/api/agent/catalog') ? catalog : workspace)));
  render(<WorkspaceProfileButton workspacePath={directory.path} aiOptions={aiOptions} />);
  fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
  await screen.findByRole('button', { name: 'Codex model project-model' });
  let finishSwitch;
  apiFetch.mockImplementation((url, options) => url.startsWith('/api/agent/catalog')
    ? new Promise(resolve => { finishSwitch = resolve; }) : Promise.resolve(response(options?.body || workspace)));
  fireEvent.change(screen.getByLabelText('Default agent for new tasks'), { target: { value: 'deepseek' } });
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek model Loading models…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enter custom model ID' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom model ID' }), { target: { value: 'custom/workspace-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
  await act(async () => { finishSwitch(response(catalog)); });
  fireEvent.click(screen.getByRole('button', { name: 'Save workspace' }));
  await screen.findByText('Workspace saved');
  expect(apiFetch.mock.calls.find(([, options]) => options?.method === 'PUT')).toEqual([
    '/api/workspace/profile?path=' + encodeURIComponent(directory.path),
    { method: 'PUT', body: { ...workspace, defaultAgent: 'deepseek', selection: { model: 'custom/workspace-model', reasoning: '' } } },
  ]);
});

it('preserves current reasoning and speed when a native selection arrives during a catalog read', async () => {
  let finish;
  apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const stale = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(<AgentModelPicker agentId="codex" value={null} onChange={stale} />);
  const selection = { model: 'custom/native-model', reasoning: 'high', serviceTier: 'ultrafast' };
  rerender(<AgentModelPicker agentId="codex" value={selection} onChange={latest} />);
  await act(async () => { finish(response(catalog)); });
  expect(stale).not.toHaveBeenCalled();
  expect(latest.mock.calls).toEqual([[{ ...selection, available: true }]]);
});

it.each(['codex', 'deepseek'])('uses the latest callback when a pending %s catalog supplies defaults', async agentId => {
  let finish;
  apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const stale = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(<AgentModelPicker agentId={agentId} value={null} onChange={stale} />);
  rerender(<AgentModelPicker agentId={agentId} value={null} onChange={latest} />);
  await act(async () => { finish(response(catalog)); });
  expect(stale).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith({ model: agents.find(agent => agent.id === agentId).models[0].id, reasoning: agentId === 'codex' ? 'high' : '', available: true });
});
