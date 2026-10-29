import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthModal } from './ProviderAuthModal';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();
const apiPostMock = vi.fn();
const showModalMock = vi.fn(function () { this.open = true; });
const closeDialogMock = vi.fn(function () { this.open = false; });
vi.mock('../utils/api', () => ({
  apiGet: (...args) => apiGetMock(...args),
  apiPut: (...args) => apiPutMock(...args),
  apiDelete: (...args) => apiDeleteMock(...args),
  apiPost: (...args) => apiPostMock(...args),
}));

const PROVIDERS = [
  { id: 'codex', label: 'Codex', methods: ['oauth'], command: 'codex login', status: 'ready', configured: true },
  { id: 'copilot', label: 'GitHub Copilot', methods: ['oauth'], command: 'gh auth login --web', help: 'GitHub opens its browser OAuth login flow.', status: 'ready', configured: true },
  { id: 'anthropic-api', label: 'Anthropic API', methods: ['api-key', 'oauth'], command: 'claude auth login --console', help: 'Claude opens the Anthropic Console OAuth flow with API usage billing.', status: 'ready', configured: true, masked: '****alue', models: 13 },
  { id: 'deepseek', label: 'DeepSeek', methods: ['api-key'], status: 'auth-required', configured: false, masked: null, models: 2 },
  { id: 'bedrock', label: 'AWS Bedrock', methods: ['cli'], command: 'aws configure', help: 'Configure AWS credentials for Bedrock.', status: 'auth-required', configured: false, models: 3 },
];

describe('ProviderAuthModal', () => {
  const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
  beforeAll(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: showModalMock },
      close: { configurable: true, value: closeDialogMock },
    });
  });
  afterAll(() => {
    for (const method of ['showModal', 'close']) {
      if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
      else delete HTMLDialogElement.prototype[method];
    }
  });
  beforeEach(() => {
    showModalMock.mockClear();
    closeDialogMock.mockClear();
    setActiveEnvironment(null);
    apiGetMock.mockReset().mockResolvedValue({ providers: PROVIDERS });
    apiPutMock.mockReset().mockResolvedValue({ configured: true, masked: '****alue' });
    apiDeleteMock.mockReset().mockResolvedValue(null);
    apiPostMock.mockReset().mockResolvedValue(null);
  });

  it('names the dialog, contains keyboard focus and restores its opener on dismissal', async () => {
    const onClose = vi.fn();
    const view = render(<><button>Provider settings</button><ProviderAuthModal isOpen={false} onClose={onClose} /></>);
    const opener = screen.getByRole('button', { name: 'Provider settings' });
    opener.focus();
    view.rerender(<><button>Provider settings</button><ProviderAuthModal isOpen onClose={onClose} /></>);
    const dialog = screen.getByRole('dialog', { name: 'Provider authentication' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(showModalMock).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    await screen.findByLabelText('DeepSeek API key');
    const last = within(dialog).getAllByRole('button').at(-1);
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<><button>Provider settings</button><ProviderAuthModal isOpen={false} onClose={onClose} /></>);
    expect(closeDialogMock).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it('requests controlled dismissal for native cancel and backdrop clicks but keeps content clicks open', async () => {
    const onClose = vi.fn();
    render(<ProviderAuthModal isOpen onClose={onClose} />);
    await screen.findByLabelText('DeepSeek API key');
    const dialog = screen.getByRole('dialog', { name: 'Provider authentication' });
    fireEvent.click(screen.getByRole('heading', { name: 'Provider authentication' }));
    expect(onClose).not.toHaveBeenCalled();
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute('open');
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('restores the AI coder trigger when its provider menu item unmounts on opening', async () => {
    function CallerFixture() {
      const [open, setOpen] = useState(false);
      return <div className="desktop-status-bar">
        <button className="status-ai-selector" aria-label="Choose AI coder">Coder</button>
        {!open && <button onClick={() => setOpen(true)}>Provider settings</button>}
        <ProviderAuthModal isOpen={open} onClose={() => setOpen(false)} />
      </div>;
    }
    render(<CallerFixture />);
    const menuItem = screen.getByRole('button', { name: 'Provider settings' });
    menuItem.focus();
    fireEvent.click(menuItem);
    await screen.findByLabelText('DeepSeek API key');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Choose AI coder' })).toHaveFocus();
  });

  it('leaves keyboard dismissal to the dialog without triggering workspace shortcuts', async () => {
    const workspaceKeyDown = vi.fn();
    const onClose = vi.fn();
    render(<div onKeyDown={workspaceKeyDown}><ProviderAuthModal isOpen onClose={onClose} /></div>);
    await screen.findByLabelText('DeepSeek API key');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('button', { name: 'Close' }), escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(workspaceKeyDown).not.toHaveBeenCalled();
  });

  it('announces provider load errors without showing an empty provider directory', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('Synthetic directory unavailable'));
    render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic directory unavailable');
    expect(screen.queryByText('No providers are available.')).not.toBeInTheDocument();
  });

  it('explains a successfully loaded empty provider directory', async () => {
    apiGetMock.mockResolvedValueOnce({ providers: [] });
    render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No providers are available.'));
  });

  it('loads OAuth and API-key options without displaying secrets', async () => {
    render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByText('Provider authentication')).toBeInTheDocument();
    expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByText('gh auth login --web')).toBeInTheDocument();
    expect(screen.getByText('claude auth login --console')).toBeInTheDocument();
    expect(screen.getByText('aws configure')).toBeInTheDocument();
    expect(screen.getAllByText('OAuth connected')).toHaveLength(3);
    expect(screen.queryByLabelText('GitHub Copilot API key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('DeepSeek API key')).toBeInTheDocument();
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument();
  });

  it('runs an OAuth command in the selected Terminal v4 session', async () => {
    render(<ProviderAuthModal isOpen onClose={vi.fn()} sessionId="terminal-1" />);
    expect(await screen.findByText('Provider authentication')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Run in current terminal' })[0]);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/terminal/terminal-1/input', { command: 'codex login\n' }));
    expect(screen.getByText(/OAuth login started in the current terminal/i)).toBeInTheDocument();
  });

  it('saves an API key through the authenticated API and clears the input', async () => {
    render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
    const input = await screen.findByLabelText('DeepSeek API key');
    fireEvent.change(input, { target: { value: 'deepseek-secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiPutMock).toHaveBeenCalledWith('/api/agent/auth/deepseek/api-key', { apiKey: 'deepseek-secret-value' }));
    await waitFor(() => expect(screen.getByLabelText('DeepSeek API key')).toHaveValue(''));
  });
  it('shows remote provider status while requiring credential management on the owning server', async () => {
    setActiveEnvironment({ id: 'remote-a', label: 'Build host' });
    render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByLabelText('DeepSeek API key')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByText(/Configure API keys on Build host/)).toBeInTheDocument();
    setActiveEnvironment(null);
  });

});
