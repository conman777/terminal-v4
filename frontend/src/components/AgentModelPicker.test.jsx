import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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

  it('shows searchable mobile model rows and switches settings without nesting menus', async () => {
    let resolveCatalog;
    apiFetchMock.mockReturnValue(new Promise(resolve => { resolveCatalog = resolve; }));
    const onChange = vi.fn();
    render(<AgentModelPicker menuControls syncSelection={false} agentId="codex" value={{ model: 'gpt-5.6-sol', reasoning: 'high' }} onChange={onChange} />);
    expect(screen.getByRole('searchbox', { name: 'Search Codex models' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeDisabled();
    resolveCatalog({ ok: true, json: async () => CATALOG });
    const model = await screen.findByRole('option', { name: 'GPT-5.5' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '5.5' } });
    expect(screen.queryByRole('option', { name: 'GPT-5.6-Sol' })).not.toBeInTheDocument();
    fireEvent.click(model);
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.5', reasoning: 'high', available: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
    fireEvent.click(screen.getByRole('option', { name: 'Medium' }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.6-sol', reasoning: 'medium' });
    expect(screen.getByRole('searchbox')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Speed: Default' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fast', exact: true }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('uses the shared searchable popup for compact pickers without nested controls', async () => {
    render(<AgentModelPicker compact agentId="codex" syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'high' }} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Codex model GPT-5.5/ }));
    expect(screen.getByRole('listbox', { name: 'Codex models' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.6-Sol' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it.each([false, true])('suppresses unsupported speed controls with menuControls=%s', async menuControls => {
    const onChange = vi.fn();
    render(<AgentModelPicker compact menuControls={menuControls} showSpeed={false} agentId="codex" syncSelection={false}
      value={{ model: 'gpt-5.5', reasoning: 'high' }} onChange={onChange} />);
    if (!menuControls) fireEvent.click(await screen.findByRole('button', { name: /^Codex model GPT-5.5/ }));
    await screen.findByRole('option', { name: 'GPT-5.6-Sol' });
    expect(screen.queryByRole('button', { name: /^Speed:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'gpt-5.5', reasoning: 'low' });
    expect(screen.queryByRole('button', { name: /^Speed:/ })).not.toBeInTheDocument();
  });

  it('loads the native Terminal v4 catalog and selects the agent default', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" value={null} onChange={onChange} />);

    expect(await screen.findByRole('button', { name: /Codex model GPT-5\.6-Sol/i })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/agent/catalog');
    expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', reasoning: 'xhigh', available: true });
  });

  it.each(['missing', 'mismatched', 'duplicate', 'error'])('marks a saved connection unavailable after a %s refresh without losing the model', async failure => {
    const id = 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001';
    const agent = { id, label: 'Saved local', runtime: 'v4', available: true, status: 'ready', models: [], capabilities: { structured: true },
      connectionProfile: { profileId: '10000000-0000-4000-8000-000000000001', revision: '60000000-0000-4000-8000-000000000001', transport: 'openai-chat' } };
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [agent] }) });
    const onChange = vi.fn();
    render(<AgentModelPicker agentId={id} value={{ model: 'own-model', reasoning: '', available: true }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Saved local model own-model' }));
    onChange.mockClear();
    apiFetchMock.mockResolvedValueOnce(failure === 'error' ? { ok: false, json: async () => ({ error: 'Synthetic catalog unavailable' }) }
      : { ok: true, json: async () => ({ agents: failure === 'missing' ? [] : failure === 'duplicate'
        ? [{ ...agent, connectionProfile: { ...agent.connectionProfile, transport: 'openai-responses' } }, { ...agent, available: false }]
        : [{ ...agent, connectionProfile: { ...agent.connectionProfile, transport: 'openai-responses' } }] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agent models' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'own-model', reasoning: '', available: false }));
    expect(await screen.findByRole('alert')).toHaveTextContent(failure === 'error' ? 'Synthetic catalog unavailable' : 'This saved connection revision is no longer available');
    expect(screen.queryByRole('button', { name: 'Use custom model' })).not.toBeInTheDocument();
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

  const savedId = 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001';
  const savedAgent = { id: savedId, label: 'Own saved', runtime: 'v4', available: true, status: 'ready',
    capabilities: { structured: true },
    connectionProfile: { profileId: '10000000-0000-4000-8000-000000000001', revision: '60000000-0000-4000-8000-000000000001', transport: 'openai-chat' },
    models: [{ id: 'own-discovered-id', label: 'Own discovered', default: true, reasoning: { allowed: ['high'], openaiWireMappingVerified: false }, imageInput: true }] };

  it('lists discovered saved models while requiring an explicit choice without inventing capabilities', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [savedAgent] }) });
    const onChange = vi.fn();
    render(<AgentModelPicker agentId={savedId} value={null} onChange={onChange} />);
    const trigger = await screen.findByRole('button', { name: 'Own saved model Choose a model ID' });
    expect(onChange.mock.calls.some(([selection]) => selection.model === 'own-discovered-id')).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith({ model: '', reasoning: '', available: true });
    expect(screen.queryByRole('combobox', { name: 'Agent reasoning effort' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Own discovered' }));
    expect(onChange).toHaveBeenLastCalledWith({ model: 'own-discovered-id', reasoning: '', available: true });
    expect(apiFetchMock.mock.calls.every(([url]) => url.startsWith('/api/agent/catalog'))).toBe(true);
  });

  it.each([{ models: [] }, { models: [{ id: 'own-new-id', label: 'Own newer inventory' }] }])('preserves an explicit model absent from refreshed discovery %j', async ({ models }) => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [savedAgent] }) });
    const onChange = vi.fn();
    function ControlledPicker() {
      const [selection, setSelection] = useState({ model: 'own-manual-id', reasoning: '', available: true });
      return <AgentModelPicker agentId={savedId} value={selection} onChange={next => { onChange(next); setSelection(next); }} />;
    }
    render(<ControlledPicker />);
    fireEvent.click(await screen.findByRole('button', { name: 'Own saved model own-manual-id' }));
    onChange.mockClear();
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ agents: [{ ...savedAgent, models }] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agent models' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'own-manual-id', reasoning: '', available: true }));
    expect(screen.getByRole('button', { name: 'Own saved model own-manual-id' })).toBeInTheDocument();
    expect(onChange.mock.calls.every(([selection]) => selection.model === 'own-manual-id')).toBe(true);
  });

  it('preserves a saved model choice that arrives during the initial discovery catalog read', async () => {
    let resolveCatalog;
    apiFetchMock.mockReturnValueOnce(new Promise(resolve => { resolveCatalog = resolve; }));
    const onChange = vi.fn();
    const { rerender } = render(<AgentModelPicker agentId={savedId} value={null} onChange={onChange} />);
    rerender(<AgentModelPicker agentId={savedId} value={{ model: 'own-late-choice', reasoning: '', available: true }} onChange={onChange} />);
    onChange.mockClear();
    resolveCatalog({ ok: true, json: async () => ({ agents: [savedAgent] }) });
    await screen.findByRole('button', { name: 'Own saved model own-late-choice' });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.every(([selection]) => selection.model === 'own-late-choice')).toBe(true);
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

  it.each([null, { model: 'gpt-5.5', reasoning: 'unsupported' }])('emits only deliberate choices when syncSelection is off (value %j)', async value => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" compact syncSelection={false} value={value} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Codex model / }));
    await screen.findByRole('option', { name: 'GPT-5.6-Sol' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
    expect(onChange.mock.calls).toEqual([[{ model: 'gpt-5.6-sol', reasoning: 'xhigh', available: true }]]);
  });

  it('blocks model, reasoning, and speed changes while disabled', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" compact disabled syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' }} onChange={onChange} />);
    const trigger = await screen.findByRole('button', { name: /Codex model GPT-5\.5/ });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('AgentModelPicker compact reasoning and Codex speed', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => CATALOG });
  });

  it('shows reasoning in the compact trigger and the shared popup', async () => {
    render(<AgentModelPicker agentId="codex" compact syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'xhigh' }} onChange={vi.fn()} />);
    const trigger = await screen.findByRole('button', { name: /^Codex model GPT-5.5/ });
    expect(trigger).toHaveTextContent('Extra high');
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Reasoning: Extra high' })).toBeInTheDocument();
  });

  it.each([
    ['an old selection without speed', {}, 'Speed: Default'],
    ['an explicit native default', { serviceTier: null }, 'Speed: Default'],
    ['Standard', { serviceTier: 'default' }, 'Speed: Standard'],
    ['Fast', { serviceTier: 'fast' }, 'Speed: Fast'],
    ['Ultrafast', { serviceTier: 'ultrafast' }, 'Speed: Ultrafast'],
  ])('shows %s in the shared popup', async (_, tier, expected) => {
    render(<AgentModelPicker agentId="codex" compact syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'high', ...tier }} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Codex model GPT-5.5/ }));
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
  });

  it('lists each speed with its usage note and emits explicit tiers', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" compact syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'high' }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Codex model GPT-5.5/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speed: Default' }));
    expect(screen.getAllByRole('option').map(item => item.getAttribute('aria-label'))).toEqual(['Default', 'Standard', 'Fast', 'Ultrafast']);
    expect(screen.getByRole('option', { name: 'Fast', exact: true })).toHaveAccessibleDescription('Higher usage; availability depends on account');
    for (const name of ['Fast', 'Standard', 'Default']) {
      if (name !== 'Fast') fireEvent.click(screen.getByRole('button', { name: 'Speed: Default' }));
      fireEvent.click(screen.getByRole('option', { name, exact: true }));
    }
    expect(onChange.mock.calls).toEqual([
      [{ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' }],
      [{ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'default' }],
      [{ model: 'gpt-5.5', reasoning: 'high', serviceTier: null }],
    ]);
  });

  it('keeps the chosen speed when the model or reasoning changes', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" compact syncSelection={false} value={{ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Codex model GPT-5.5/ }));
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(onChange.mock.calls).toEqual([
      [{ model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast', available: true }],
      [{ model: 'gpt-5.5', reasoning: 'low', serviceTier: 'fast' }],
    ]);
  });

  it('keeps a saved speed through catalog hydration and leaves an unspecified speed unset', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AgentModelPicker agentId="codex" compact value={{ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'ultrafast' }} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'ultrafast', available: true }));
    onChange.mockClear();
    rerender(<AgentModelPicker agentId="codex" compact value={{ model: 'gpt-5.5', reasoning: 'low' }} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.every(([selection]) => !('serviceTier' in selection))).toBe(true);
  });

  it('selects the catalog default without opting into a faster speed', async () => {
    const onChange = vi.fn();
    render(<AgentModelPicker agentId="codex" compact value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('serviceTier');
  });

  it('shows speed only for Codex', async () => {
    render(<AgentModelPicker agentId="claude" compact syncSelection={false} value={{ model: 'sonnet', reasoning: 'high', serviceTier: 'fast' }} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Claude Code model Sonnet/ }));
    expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Speed:/ })).not.toBeInTheDocument();
  });
});


it('uses the V4 runtime and lets a user enter a provider model', async () => {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [{
    id: 'deepseek', label: 'DeepSeek', runtime: 'v4', available: true, status: 'ready', models: [],
    launchCommand: '"C:\\tools\\terminal-v4-api.exe"', hostShell: 'cmd',
  }] }) });
  const onChange = vi.fn();
  render(<AgentModelPicker agentId="deepseek" value={null} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: /DeepSeek model Provider default/ }));
  expect(onChange).toHaveBeenCalledWith({ model: '', reasoning: '', launchCommand: '"C:\\tools\\terminal-v4-api.exe"', hostShell: 'cmd', available: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom model ID' }), { target: { value: 'nous/my-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
  expect(onChange).toHaveBeenLastCalledWith({ model: 'nous/my-model', reasoning: '', launchCommand: '"C:\\tools\\terminal-v4-api.exe"', hostShell: 'cmd', available: true });
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

it('clears model-unsupported reasoning on selection and refreshed metadata while keeping explicit none hidden', async () => {
  const agent = { id: 'claude', label: 'Claude Code', available: true, status: 'ready', reasoningLevels: ['low','high','xhigh'], models: [
    { id: 'fable', label: 'Fable fixture', reasoningLevels: ['high','xhigh'] },
    { id: 'limited', label: 'Limited fixture', reasoningLevels: ['low','high'] },
    { id: 'none', label: 'No reasoning fixture', reasoningLevels: [] },
  ] };
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [agent] }) });
  const onChange = vi.fn();
  const { rerender } = render(<AgentModelPicker agentId="claude" value={{ model: 'fable', reasoning: 'xhigh' }} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: /Claude Code model Fable fixture/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Limited fixture' }));
  expect(onChange).toHaveBeenLastCalledWith({ model: 'limited', reasoning: 'high', available: true });
  rerender(<AgentModelPicker agentId="claude" value={{ model: 'none', reasoning: 'high' }} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'none', reasoning: '', available: true }));
  expect(screen.queryByRole('combobox', { name: 'Agent reasoning effort' })).not.toBeInTheDocument();
  rerender(<AgentModelPicker agentId="claude" value={{ model: 'fable', reasoning: 'xhigh' }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /Claude Code model Fable fixture/ }));
  apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ agents: [{ ...agent, models: [{ id: 'fable', label: 'Fable fixture', reasoningLevels: ['high'] }] }] }) });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh agent models' }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'fable', reasoning: 'high', available: true }));
  expect(screen.queryByRole('option', { name: 'xhigh' })).not.toBeInTheDocument();
});

it('offers no invented reasoning for an unknown custom V4 model', async () => {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', label: 'OpenAI API', runtime: 'v4', available: true, status: 'ready', reasoningLevels: ['high','xhigh'], models: [{ id: 'known', label: 'Known', reasoningLevels: ['high'] }] }] }) });
  const onChange = vi.fn();
  render(<AgentModelPicker agentId="openai-api" value={{ model: 'custom/unknown', reasoning: 'xhigh' }} onChange={onChange} />);
  await screen.findByRole('button', { name: /OpenAI API model custom\/unknown/ });
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'custom/unknown', reasoning: '', available: true }));
  expect(screen.queryByRole('combobox', { name: 'Agent reasoning effort' })).not.toBeInTheDocument();
});

it.each([
  [undefined, 'high'], ['low', 'low'], ['unsupported', 'high'],
])('keeps the V4 initial default bounded for model defaultReasoning %s', async (defaultReasoning, expected) => {
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', label: 'OpenAI API', runtime: 'v4', available: true, status: 'ready', reasoningLevels: ['low','high','xhigh'], models: [{ id: 'fixture-model', label: 'Fixture model', default: true, reasoningLevels: ['low','high','xhigh'], ...(defaultReasoning ? { defaultReasoning } : {}) }] }] }) });
  const onChange = vi.fn();
  render(<AgentModelPicker agentId="openai-api" value={null} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ model: 'fixture-model', reasoning: expected, available: true }));
});

it.each(['high', 'xhigh'])('preserves an explicit V4 %s selection when metadata is refreshed', async reasoning => {
  const agent = { id: 'openai-api', label: 'OpenAI API', runtime: 'v4', available: true, status: 'ready', models: [{ id: 'fixture-model', label: 'Fixture model', reasoningLevels: ['low','high','xhigh'], defaultReasoning: 'high' }] };
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [agent] }) });
  const onChange = vi.fn();
  render(<AgentModelPicker agentId="openai-api" value={{ model: 'fixture-model', reasoning, available: true }} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: /OpenAI API model Fixture model/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh agent models' }));
  await waitFor(() => expect(apiFetchMock).toHaveBeenLastCalledWith('/api/agent/catalog?refresh=true'));
  expect(screen.getByRole('combobox', { name: 'Agent reasoning effort' })).toHaveValue(reasoning);
  expect(onChange).not.toHaveBeenCalled();
});
