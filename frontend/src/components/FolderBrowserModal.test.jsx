import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FolderBrowserModal } from './FolderBrowserModal';

const apiFetchMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiFetch: (...args) => apiFetchMock(...args)
}));

describe('FolderBrowserModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('does not reload the same directory when ai options rerender with a new array identity', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
        folders: ['src'],
        parent: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects'
      })
    });

    const props = {
      isOpen: true,
      onClose: vi.fn(),
      currentPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      recentFolders: [],
      onSelect: vi.fn(),
      showAiSelector: true,
      defaultAiOptionId: 'cli'
    };

    const { rerender } = render(
      <FolderBrowserModal
        {...props}
        aiOptions={[
          { id: 'cli', label: 'CLI' },
          { id: 'claude', label: 'Claude Code', title: 'Claude Code', command: 'claude --dangerously-skip-permissions' }
        ]}
      />
    );

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <FolderBrowserModal
        {...props}
        aiOptions={[
          { id: 'cli', label: 'CLI' },
          { id: 'claude', label: 'Claude Code', title: 'Claude Code', command: 'claude --dangerously-skip-permissions' }
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open here' })).toBeInTheDocument();
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});
