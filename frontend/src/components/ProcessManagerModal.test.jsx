import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessManagerModal } from './ProcessManagerModal';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ apiFetch }));

describe('ProcessManagerModal with synthetic processes', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('renders a named dialog and dispatches Stop only for the selected fixture process', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ repos: [{ path: '/fixture/project', name: 'Fixture project', running: true, projectType: 'node', processes: [{ pid: 1234, port: 3000 }] }] }) });
    render(<ProcessManagerModal isOpen projects={[{ path: '/fixture/project' }]} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Process Manager' })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/processes/stop', expect.objectContaining({ method: 'POST', body: JSON.stringify({ pid: 1234 }) })));
  });

  it('announces a failed listing and provides a working Refresh action', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, json: async () => ({ repos: [] }) });
    render(<ProcessManagerModal isOpen projects={[{ path: '/fixture/project' }]} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch processes');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText(/No projects found/)).toBeVisible();
  });
});
