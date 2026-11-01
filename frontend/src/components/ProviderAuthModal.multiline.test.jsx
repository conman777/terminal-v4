import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { ProviderAuthModal } from './ProviderAuthModal';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../utils/api', () => ({
  apiGet: (...args) => apiGetMock(...args),
  apiPut: (...args) => apiPutMock(...args),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
}));

const PROVIDERS = ['vertex', 'bedrock', 'deepseek'].map(id => ({ id, label: id, methods: ['api-key'], status: 'auth-required', configured: false }));
const JSON_KEY = '{\n  "accessKeyId": "AKIA",\n  "secretAccessKey": "s"\n}';

describe('ProviderAuthModal multi-line credentials', () => {
  const saved = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
  beforeAll(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value() { this.open = true; } },
      close: { configurable: true, value() { this.open = false; } },
    });
  });
  afterAll(() => {
    for (const method of ['showModal', 'close']) {
      if (saved[method]) Object.defineProperty(HTMLDialogElement.prototype, method, saved[method]);
      else delete HTMLDialogElement.prototype[method];
    }
  });
  beforeEach(() => {
    setActiveEnvironment(null);
    apiGetMock.mockReset().mockResolvedValue({ providers: PROVIDERS });
    apiPutMock.mockReset().mockResolvedValue({ configured: true });
  });

  it('uses a textarea for vertex and bedrock only', async () => {
    render(<ProviderAuthModal isOpen onClose={() => {}} />);
    const vertex = await screen.findByLabelText('vertex API key');
    expect(vertex.tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('bedrock API key').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('deepseek API key').tagName).toBe('INPUT');
    expect(screen.getByLabelText('deepseek API key')).toHaveAttribute('type', 'password');
  });

  it('sends pasted multi-line JSON verbatim apart from trimming and clears it after save', async () => {
    render(<ProviderAuthModal isOpen onClose={() => {}} />);
    const field = await screen.findByLabelText('bedrock API key');
    fireEvent.change(field, { target: { value: JSON_KEY } });
    expect(field).toHaveValue(JSON_KEY);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
    await waitFor(() => expect(apiPutMock).toHaveBeenCalledWith('/api/agent/auth/bedrock/api-key', { apiKey: JSON_KEY }));
    await waitFor(() => expect(screen.getByLabelText('bedrock API key')).toHaveValue(''));
  });
});
