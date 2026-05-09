import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

vi.mock('../utils/api', () => ({
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: (...args) => apiPatchMock(...args)
}));

vi.mock('./PasskeyManager', () => ({
  default: () => null
}));

describe('ApiSettingsModal', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
  });

  it('shows sandbox controls as unavailable even when old settings contain sandbox mode', async () => {
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

    expect(await screen.findByText('Current default: Host')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
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

    const toggle = await screen.findByRole('button', { name: 'Unavailable' });
    expect(toggle).toBeDisabled();

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Current default: Host')).toBeInTheDocument();
  });
});
