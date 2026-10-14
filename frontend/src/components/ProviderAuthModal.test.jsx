import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthModal } from './ProviderAuthModal';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();
const apiPostMock = vi.fn();
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
  beforeEach(() => {
    apiGetMock.mockReset().mockResolvedValue({ providers: PROVIDERS });
    apiPutMock.mockReset().mockResolvedValue({ configured: true, masked: '****alue' });
    apiDeleteMock.mockReset().mockResolvedValue(null);
    apiPostMock.mockReset().mockResolvedValue(null);
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
});
