import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('loads and displays the current sandbox default', async () => {
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

    expect(await screen.findByText('Current default: Sandboxed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'On' })).toBeInTheDocument();
  });

  it('toggles the sandbox default for new terminals', async () => {
    const user = userEvent.setup();
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

    const toggle = await screen.findByRole('button', { name: 'Off' });
    await user.click(toggle);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith('/api/settings', {
        sandboxDefaultMode: 'workspace-write'
      });
    });
    expect(await screen.findByText('Current default: Sandboxed')).toBeInTheDocument();
  });
});
