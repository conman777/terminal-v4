import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSettingsModal } from './BrowserSettingsModal';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
const config = { enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] };
afterEach(() => { cleanup(); setActiveEnvironment(null); vi.unstubAllGlobals(); });

it('uses the supported Home browser API from the legacy drawer entry and retains failed-save edits for retry', async () => {
  setActiveEnvironment({ id: 'synthetic-paired' });
  const requests = [];
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (options.method === 'PUT' && ++writes === 1) return { ok: false, status: 503, json: async () => ({ error: 'Synthetic save unavailable' }) };
    return { ok: true, status: 200, json: async () => options.body ? JSON.parse(options.body) : config };
  }));
  render(<BrowserSettingsModal isOpen onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Allowed origins'), { target: { value: 'https://synthetic.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save browser settings' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic save unavailable');
  expect(screen.getByLabelText('Allowed origins')).toHaveValue('https://synthetic.test');
  fireEvent.click(screen.getByRole('button', { name: 'Save browser settings' }));
  expect(await screen.findByText('Browser settings saved. No browser was started.')).toBeVisible();
  expect(requests).toEqual([
    { url: '/api/agent/browser', method: 'GET', body: undefined },
    ...Array(2).fill({ url: '/api/agent/browser', method: 'PUT', body: { ...config, allowedOrigins: ['https://synthetic.test'] } }),
  ]);
  expect(screen.queryByText('Max Lifetime')).not.toBeInTheDocument();
  expect(screen.getByText(/Browser actions.*Reset/)).toBeVisible();
});

it('retries a failed supported config load without showing unused lifecycle fields', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Synthetic browser unavailable' }) }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => config });
  vi.stubGlobal('fetch', fetchMock);
  render(<BrowserSettingsModal isOpen onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic browser unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading browser settings' }));
  expect(await screen.findByRole('button', { name: 'Save browser settings' })).toBeEnabled();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/agent/browser', '/api/agent/browser']);
});
