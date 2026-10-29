import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTasksPanel } from './WorkspaceTasksPanel';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/api', () => ({ apiFetch: (...args) => fixture.fetch(...args) }));

const workspacePath = '/synthetic/task-workspace';
const firstPrompt = 'Inspect synthetic files';
const nextPrompt = 'Keep this follow-up draft';
const jsonResponse = body => ({ ok: true, json: async () => body });

describe('WorkspaceTasksPanel request completion contracts', () => {
  it('retains a follow-up draft typed while a prior task submission is pending', async () => {
    let completeSubmission;
    fixture.fetch.mockImplementation((url, options) => {
      if (options?.method === 'POST') return new Promise(resolve => { completeSubmission = resolve; });
      if (url === '/api/agent/catalog') return Promise.resolve(jsonResponse({ agents: [{ id: 'claude', label: 'Claude Code', available: true, capabilities: { durableTasks: true } }] }));
      return Promise.resolve(jsonResponse({ tasks: [], schedules: [] }));
    });
    render(<WorkspaceTasksPanel workspacePath={workspacePath} />);
    await screen.findByText('No tasks yet.');
    const prompt = screen.getByLabelText('Task prompt');
    fireEvent.change(prompt, { target: { value: firstPrompt } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    await waitFor(() => expect(completeSubmission).toBeTypeOf('function'));
    expect(prompt).toBeEnabled();
    fireEvent.change(prompt, { target: { value: nextPrompt } });
    await act(async () => { completeSubmission(jsonResponse({ id: 'synthetic-task', status: 'queued' })); });
    expect(prompt).toHaveValue(nextPrompt);
  });
});
