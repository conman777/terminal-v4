import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { WorkspaceStartView } from './WorkspaceStartView';

const mocks = vi.hoisted(() => ({ agents: [], catalogCalls: 0 }));
vi.mock('../utils/api', () => ({ apiFetch: async url => {
  const isCatalog = String(url).startsWith('/api/agent/catalog');
  if (isCatalog) mocks.catalogCalls += 1;
  return { ok: true, json: async () => isCatalog ? { agents: mocks.agents } : {} };
} }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));
vi.mock('./AgentModelPicker', () => ({ AgentModelPicker: () => null }));
vi.mock('./ProviderAuthModal', () => ({ ProviderAuthModal: ({ isOpen, onClose, focusProviderId }) => isOpen
  ? <div role="dialog" aria-label="Provider authentication" data-provider={focusProviderId}><button type="button" onClick={onClose}>Close</button></div> : null }));

const codex = { id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'm', default: true }] };
const azure = { id: 'azure-foundry', label: 'Azure AI Foundry', runtime: 'v4', available: false, status: 'not-configured', capabilities: { structured: true }, models: [] };

beforeEach(() => {
  localStorage.clear();
  setUser({ id: 'fixture-user' });
  mocks.catalogCalls = 0;
  mocks.agents = [codex, azure];
});

async function chooseAzure() {
  fireEvent.click(await screen.findByRole('button', { name: 'Agent' }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /Azure AI Foundry/ }));
}

describe('WorkspaceStartView provider setup', () => {
  it('offers Set up for an unavailable provider, opens its auth modal and rechecks after close', async () => {
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Set up/ })).not.toBeInTheDocument();
    await chooseAzure();
    const setup = await screen.findByRole('button', { name: 'Set up Azure AI Foundry' });
    fireEvent.click(setup);
    expect(screen.getByRole('dialog', { name: 'Provider authentication' })).toHaveAttribute('data-provider', 'azure-foundry');
    const before = mocks.catalogCalls;
    mocks.agents = [codex, { ...azure, available: true, status: 'ready', models: [{ id: 'd', default: true }] }];
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(mocks.catalogCalls).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Set up Azure AI Foundry' })).not.toBeInTheDocument());
    expect(setup.isConnected).toBe(false);
  });

  it('returns focus to the Set up button on cancel while it is still needed', async () => {
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} />);
    await chooseAzure();
    const setup = await screen.findByRole('button', { name: 'Set up Azure AI Foundry' });
    setup.focus();
    fireEvent.click(setup);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up Azure AI Foundry' })).toHaveFocus());
  });

  it('offers Set up for an unavailable Codex agent as well', async () => {
    mocks.agents = [{ ...codex, available: false, status: 'auth-required' }];
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Set up Codex' })).toBeEnabled();
  });

  it('is operable from the keyboard: Tab reaches Set up after the composer and Enter opens the modal', async () => {
    const user = userEvent.setup();
    render(<WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} />);
    await chooseAzure();
    const setup = await screen.findByRole('button', { name: 'Set up Azure AI Foundry' });
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    expect(composer.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(setup.tabIndex).toBe(0);
    setup.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Provider authentication' })).toBeInTheDocument();
  });
});
