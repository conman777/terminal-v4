import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceTasksPanel } from './WorkspaceTasksPanel';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const path = 'C:/projects/demo';
const task = { id: 'task-one', provider: 'hermes', prompt: 'Review', status: 'completed', result: 'Review finished.', output: 'Review finished.', createdAt: 1000, events: [], parentSessionId: 'ss-parent' };
const schedule = { id: 'schedule-one', name: 'Morning review', provider: 'claude', enabled: false, intervalSeconds: 3600 };
describe('WorkspaceTasksPanel', () => {
  beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [], schedules: [] }) }); });

  it('queues selected native agent tasks linked to the current conversation', async () => {
    render(<WorkspaceTasksPanel workspacePath={path} currentSessionId="ss-parent" />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Task agent'), { target: { value: 'hermes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/tasks', { method: 'POST', body: { workspacePath: path, provider: 'hermes', prompt: 'Check build', model: null, parentSessionId: 'ss-parent', parentTaskId: null } }));
  });

  it('creates disabled recurring schedules until the user explicitly enables one', async () => {
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules', { method: 'POST', body: { workspacePath: path, provider: 'claude', prompt: 'Check build', model: null, parentSessionId: null, parentTaskId: null, name: 'Review', intervalSeconds: 3600, enabled: false } }));
  });

  it('shows native results, inserts them for review, and enables or runs schedules explicitly', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [task], schedules: [schedule] }) });
    const onInsertPrompt = vi.fn();
    render(<WorkspaceTasksPanel workspacePath={path} onInsertPrompt={onInsertPrompt} />);
    expect(await screen.findByText('Review finished.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result to prompt' }));
    expect(onInsertPrompt).toHaveBeenCalledWith('Task result (hermes):\nReview finished.');
    fireEvent.click(screen.getByRole('button', { name: 'Enable Morning review' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one', { method: 'PATCH', body: { enabled: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one/run', { method: 'POST' }));
  });

  it('retains the draft and reports failed queue requests', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method ? { ok: false, json: async () => ({ error: 'Agent unavailable' }) } : { ok: true, json: async () => ({ tasks: [], schedules: [] }) });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Keep draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent unavailable');
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Keep draft');
  });
});


describe('WorkspaceTasksPanel provider adapters', () => {
  it('queues available API adapters and disables unconfigured providers from the live catalog', async () => {
    apiFetch.mockImplementation(async url => ({ ok: true, json: async () => url === '/api/agent/catalog'
      ? { agents: [
        { id: 'claude', label: 'Claude Code', available: true, capabilities: { durableTasks: true } },
        { id: 'openai-api', label: 'OpenAI API', available: true, capabilities: { durableTasks: true } },
        { id: 'deepseek', label: 'DeepSeek', available: false, capabilities: { durableTasks: true } },
        { id: 'vertex', label: 'Vertex', available: false, capabilities: { durableTasks: false } },
      ] } : { tasks: [], schedules: [] } }));
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByRole('option', { name: 'OpenAI API' });
    expect(screen.getByRole('option', { name: /DeepSeek/ })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Vertex' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task agent'), { target: { value: 'openai-api' } });
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review the patch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/tasks', {
      method: 'POST', body: { workspacePath: path, provider: 'openai-api', prompt: 'Review the patch', model: null, parentSessionId: null, parentTaskId: null }
    }));
  });
});
