import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthModal } from './ProviderAuthModal';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../utils/api', () => ({
  apiGet: (...args) => apiGetMock(...args),
  apiPut: (...args) => apiPutMock(...args),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
}));

const AZURE = { id: 'azure-foundry', label: 'Azure AI Foundry', methods: ['api-key'], status: 'not-configured', configured: false, settings: [
  { key: 'endpoint', label: 'Resource endpoint', required: true },
  { key: 'apiVersion', label: 'API version', required: true },
  { key: 'authHeader', label: 'Auth header', required: false },
] };
const OTHER = { id: 'deepseek', label: 'DeepSeek', methods: ['api-key'], status: 'auth-required', configured: false };

describe('ProviderAuthModal entry from a chosen provider', () => {
  const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
  beforeAll(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: function () { this.open = true; } },
      close: { configurable: true, value: function () { this.open = false; } },
    });
  });
  afterAll(() => {
    for (const method of ['showModal', 'close']) {
      if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
      else delete HTMLDialogElement.prototype[method];
    }
  });
  beforeEach(() => {
    setActiveEnvironment(null);
    apiGetMock.mockReset().mockResolvedValue({ providers: [OTHER, AZURE] });
    apiPutMock.mockReset().mockResolvedValue({ configured: true });
  });

  it('moves focus to the requested provider first field once statuses load', async () => {
    render(<ProviderAuthModal isOpen onClose={() => {}} focusProviderId="azure-foundry" />);
    const endpoint = await screen.findByLabelText('Azure AI Foundry Resource endpoint (required)');
    expect(endpoint).toHaveFocus();
  });

  it('focuses the API key when the requested provider has no extra settings', async () => {
    render(<ProviderAuthModal isOpen onClose={() => {}} focusProviderId="deepseek" />);
    expect(await screen.findByLabelText('DeepSeek API key')).toHaveFocus();
  });

  it('saves the Azure endpoint, version and optional header from that entry point and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ProviderAuthModal isOpen onClose={onClose} focusProviderId="azure-foundry" />);
    fireEvent.change(await screen.findByLabelText('Azure AI Foundry Resource endpoint (required)'), { target: { value: 'https://r.openai.azure.com' } });
    fireEvent.change(screen.getByLabelText('Azure AI Foundry API version (required)'), { target: { value: '2024-10-21' } });
    fireEvent.change(screen.getByLabelText('Azure AI Foundry Auth header'), { target: { value: 'api-key' } });
    fireEvent.change(screen.getByLabelText('Azure AI Foundry API key'), { target: { value: 'azure-secret-value' } });
    fireEvent.click(within(screen.getByLabelText('Azure AI Foundry API key').closest('section')).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(apiPutMock).toHaveBeenCalledWith('/api/agent/auth/azure-foundry/api-key', { apiKey: 'azure-secret-value', settings: { endpoint: 'https://r.openai.azure.com', apiVersion: '2024-10-21', authHeader: 'api-key' } }));
    fireEvent.keyDown(screen.getByLabelText('Azure AI Foundry API key'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
