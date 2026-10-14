import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentModelPicker } from './AgentModelPicker';

const apiFetchMock = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetchMock(...args) }));

const CATALOG = {
  defaultAgent: 'codex',
  agents: [
    {
      id: 'codex', label: 'Codex', command: 'codex', available: true, authenticated: true, status: 'ready',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', default: true }, { id: 'gpt-5.5', label: 'GPT-5.5' }],
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      id: 'claude', label: 'Claude Code', command: 'claude', available: true, authenticated: false, status: 'auth-required',
      models: [{ id: 'sonnet', label: 'Sonnet', default: true }, { id: 'opus', label: 'Opus' }],
      reasoningLevels: ['low', 'high'],
    },
  ],
};

describe('AgentModelPicker', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => CATALOG });
  });

  it('loads the native Terminal v4 catalog and selects the agent default', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" value={null} onChange={onChange} />);

    expect(await screen.findByRole('button', { name: /Codex model GPT-5\.6-Sol/i })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/agent/catalog');
    expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', reasoning: 'xhigh' });
  });

  it('filters native models and emits the selected model', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" value={{ model: 'gpt-5.6-sol', reasoning: 'high' }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Codex model GPT-5\.6-Sol/i }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Codex models' }), { target: { value: '5.5' } });
    expect(document.querySelector('.tv4-agent-model-option')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'GPT-5.6-Sol' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.5' }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.5', reasoning: 'high' });
  });

  it('shows auth-required status and refresh failures', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="claude" value={null} onChange={onChange} />);
    expect(await screen.findByText(/authentication required/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code model Sonnet/i }));
    apiFetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Catalog unavailable' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agent models' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenLastCalledWith('/api/agent/catalog?refresh=true'));
    expect(await screen.findByText('Catalog unavailable')).toBeInTheDocument();
  });
});
