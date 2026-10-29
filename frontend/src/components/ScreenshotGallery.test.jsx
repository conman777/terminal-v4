import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { ScreenshotGallery } from './ScreenshotGallery';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const json = body => ({ ok: true, json: async () => body, blob: async () => new Blob(['png']) });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:shot');
  URL.revokeObjectURL = vi.fn();
});

describe('ScreenshotGallery', () => {
  it('lists saved screenshots, captures a new one from a port and deletes one', async () => {
    let shots = [{ filename: 'one.png', size: 10, createdAt: '2026-10-26T10:00:00Z' }];
    vi.mocked(apiFetch).mockImplementation(async (url, options = {}) => {
      if (url === '/api/preview/screenshots') return json({ screenshots: shots });
      if (url === '/api/preview/5173/screenshot') { shots = [{ filename: 'two.png', size: 10, createdAt: '2026-10-26T11:00:00Z' }, ...shots]; return json({ success: true }); }
      if (options.method === 'DELETE') { shots = shots.filter(shot => !url.endsWith(shot.filename)); return { ok: true, status: 204 }; }
      return json({});
    });
    render(<ScreenshotGallery open onClose={vi.fn()} />);
    expect(await screen.findByRole('img', { name: 'one.png' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5173' } });
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    expect(await screen.findByRole('img', { name: 'two.png' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete one.png' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'one.png' })).toBeNull());
  });
});
