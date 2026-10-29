import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApiSettingsModal from './ApiSettingsModal';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'conor'
    }
  })
}));

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiGet: (...args) => apiGetMock(...args),
  apiPost: (...args) => apiPostMock(...args),
  apiDelete: (...args) => apiDeleteMock(...args),
  apiPatch: (...args) => apiPatchMock(...args)
}));

vi.mock('./PasskeyManager', () => ({
  default: () => null
}));

describe('ApiSettingsModal', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    apiDeleteMock.mockReset();
  });

  it('shows no sandbox control, since terminals always run with host access', async () => {
    apiGetMock.mockImplementation(async (url) => {
      if (url === '/api/settings') {
        return {
          hasGroqApiKey: false,
          groqApiKey: null,
          sandboxDefaultMode: 'workspace-write'
        };
      }
      if (url === '/api/vault') {
        return { keys: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);

    await screen.findByLabelText(/Groq/i);
    expect([screen.queryByText('Sandbox New Terminals'), screen.queryByRole('button', { name: 'Unavailable' })]).toEqual([null, null]);
  });

  it('does not save unsupported sandbox defaults', async () => {
    apiGetMock.mockImplementation(async (url) => {
      if (url === '/api/settings') {
        return {
          hasGroqApiKey: false,
          groqApiKey: null,
          sandboxDefaultMode: 'off'
        };
      }
      if (url === '/api/vault') {
        return { keys: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    apiPatchMock.mockResolvedValue({ success: true });

    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);

    await screen.findByLabelText(/Groq/i);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });
});


describe('ApiSettingsModal vault API contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockImplementation(async (url) => {
      if (url === '/api/settings') return { hasGroqApiKey: false };
      if (url === '/api/vault') return { keys: [{ id: 'fixture-key', keyName: 'Synthetic provider', keyValue: '****1234' }] };
      if (url === '/api/vault/fixture-key/reveal') return { keyValue: 'synthetic-secret-1234' };
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('renders canonical key names and masks and copies only the revealed keyValue', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);
    expect(await screen.findByText('Synthetic provider')).toBeInTheDocument();
    expect(screen.getByText('****1234')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('synthetic-secret-1234'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('creates vault entries using the canonical keyName and keyValue fields', async () => {
    apiPostMock.mockResolvedValue({ id: 'created-key' });
    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Key' }));
    fireEvent.change(screen.getByPlaceholderText('Key name (e.g. Anthropic)'), { target: { value: '  Fixture  ' } });
    fireEvent.change(screen.getByPlaceholderText('Key value'), { target: { value: 'synthetic-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/vault', { keyName: 'Fixture', keyValue: 'synthetic-value' }));
    expect(await screen.findByText('Key added to vault')).toBeInTheDocument();
  });

  it('labels vault credentials and reports save failure while keeping the entered values', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('Synthetic save unavailable'));
    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Key' }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Fixture' } });
    fireEvent.change(screen.getByLabelText('Key value'), { target: { value: 'synthetic-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic save unavailable');
    expect(screen.getByLabelText('Key value')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Key value')).toHaveValue('synthetic-value');
  });

  it('identifies a vault entry by its canonical keyName when deleting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiDeleteMock.mockResolvedValue(null);
    render(<ApiSettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith('/api/vault/fixture-key'));
    expect(confirm).toHaveBeenCalledWith('Delete key "Synthetic provider"?');
    confirm.mockRestore();
  });
});
