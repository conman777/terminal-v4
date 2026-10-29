import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSettings } from './BrowserSettings';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ apiFetch }));
const config = { enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] };
const response = () => ({ ok: true, json: async () => config });

describe('BrowserSettings supported configuration', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('shows a failed load and retries the supported agent configuration', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Synthetic settings unavailable' }) }).mockResolvedValueOnce(response());
    render(<BrowserSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic settings unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading browser settings' }));
    expect(await screen.findByLabelText('Allowed origins')).toHaveValue('');
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/agent/browser', '/api/agent/browser']);
  });

  it('validates supported action timeouts without saving unused lifecycle controls', async () => {
    apiFetch.mockImplementation(async () => response());
    render(<BrowserSettings />);
    fireEvent.change(await screen.findByLabelText('Action timeout (seconds)'), { target: { value: '61' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save browser settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 60');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/Idle Timeout/)).not.toBeInTheDocument();
  });
});
