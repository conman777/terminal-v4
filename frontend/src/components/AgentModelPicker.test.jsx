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
    expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', reasoning: 'xhigh', available: true });
  });

  it('filters native models and emits the selected model', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" value={{ model: 'gpt-5.6-sol', reasoning: 'high' }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Codex model GPT-5\.6-Sol/i }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Codex models' }), { target: { value: '5.5' } });
    expect(document.querySelector('.tv4-agent-model-option')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'GPT-5.6-Sol' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.5' }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.5', reasoning: 'high', available: true });
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

  it('hydrates a saved project model with the live catalog launcher', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({
      agents: [{ id: 'deepseek', label: 'DeepSeek', status: 'ready', launchCommand: 'node /runtime/api-agent-runner.js',
        models: [{ id: 'deepseek-model', label: 'DeepSeek model' }] }],
    }) });
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="deepseek" value={{ model: 'deepseek-model', reasoning: 'high' }} onChange={onChange} />);
    await screen.findByRole('button', { name: /DeepSeek model/ });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      model: 'deepseek-model', reasoning: 'high', launchCommand: 'node /runtime/api-agent-runner.js',
    }));
  });

  it('hydrates a project choice that arrives after the catalog for the same agent', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({
      agents: [{ id: 'deepseek', label: 'DeepSeek', status: 'ready', launchCommand: 'node /runtime/api-agent-runner.js',
        models: [{ id: 'model-one', label: 'First model' }, { id: 'model-two', label: 'Second model' }] }],
    }) });
    const onChange = vi.fn();
    const { rerender } = render(<AgentModelPicker agentId="deepseek" value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    onChange.mockClear();
    rerender(<AgentModelPicker agentId="deepseek" value={{ model: 'model-two', reasoning: 'high' }} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({
      model: 'model-two', reasoning: 'high', launchCommand: 'node /runtime/api-agent-runner.js',
    }));
  });
});


it('uses Hermes configured default and lets a user enter a provider model', async () => {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [{
    id: 'hermes', label: 'Hermes', available: true, status: 'ready', models: [],
    launchCommand: '"C:\\tools\\hermes.exe"', hostShell: 'cmd',
  }] }) });
  const onChange = vi.fn();
  render(<AgentModelPicker agentId="hermes" value={null} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: /Hermes model Provider default/ }));
  expect(onChange).toHaveBeenCalledWith({ model: '', reasoning: '', launchCommand: '"C:\\tools\\hermes.exe"', hostShell: 'cmd', available: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom model ID' }), { target: { value: 'nous/my-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
  expect(onChange).toHaveBeenLastCalledWith({ model: 'nous/my-model', reasoning: '', launchCommand: '"C:\\tools\\hermes.exe"', hostShell: 'cmd', available: true });
});


it('ignores a stale catalog response after switching agents', async () => {
  let resolveFirst;
  apiFetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => CATALOG });
  const onChange = vi.fn();
  const { rerender } = render(<AgentModelPicker agentId="codex" value={null} onChange={onChange} />);
  rerender(<AgentModelPicker agentId="claude" value={null} onChange={onChange} />);
  await screen.findByRole('button', { name: /Claude Code model Sonnet/ });
  onChange.mockClear();
  resolveFirst({ ok: true, json: async () => CATALOG });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onChange).not.toHaveBeenCalled();
});
