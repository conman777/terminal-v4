import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { WorkspaceStartView } from './WorkspaceStartView';

const mocks = vi.hoisted(() => ({ catalog: null, error: null }));
vi.mock('../utils/api', () => ({ apiFetch: async url => {
  if (String(url).startsWith('/api/agent/catalog') && mocks.error) throw mocks.error;
  return { ok: true, json: async () => String(url).startsWith('/api/agent/catalog') ? mocks.catalog : {} };
} }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));
vi.mock('./AgentModelPicker', () => ({ AgentModelPicker: ({ onChange }) => <button type="button" onClick={() => onChange({ model: 'test-model', available: false })}>Use unavailable model</button> }));

beforeEach(() => {
  localStorage.clear();
  setUser({ id: 'fixture-user' });
  mocks.error = null;
  mocks.catalog = { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, capabilities: { structured: true }, models: [{ id: 'test-model' }] }] };
});

describe('WorkspaceStartView selected-model guidance', () => {
  it('uses only catalog retry after a failed availability recheck and retains the prompt', async () => {
    const submit = vi.fn();
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use unavailable model' }));
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this prompt after recheck fails' } });
    mocks.error = new Error('Synthetic recheck unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Recheck availability' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic recheck unavailable');
    expect(screen.getByRole('button', { name: 'Retry loading agents' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Recheck availability' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(composer).toHaveValue('Keep this prompt after recheck fails');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([undefined, 'This synthetic model is not available on the selected connection.'])('explains a rejected model selection using its catalog reason when provided: %j', async reason => {
    mocks.catalog.agents[0].models[0].reason = reason;
    const submit = vi.fn();
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use unavailable model' }));
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task while choosing a model' } });
    const message = reason ? `The selected model is unavailable. ${reason}` : 'The selected model is unavailable. Choose another model or recheck availability.';
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByText('Project selected. Describe your task above, then send to start.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recheck availability' })).toBeEnabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Keep this task while choosing a model');
  });
});
