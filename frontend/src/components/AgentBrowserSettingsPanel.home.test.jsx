import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentBrowserSettingsPanel } from './AgentBrowserSettingsPanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const defaults = { enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] };
afterEach(() => { setActiveEnvironment(null); vi.unstubAllGlobals(); });

it('loads and saves the shared browser on Home while a paired environment is selected', async () => {
  setActiveEnvironment({ id: 'synthetic-paired-environment' });
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    return { ok: true, status: 200, json: async () => defaults };
  }));
  render(<AgentBrowserSettingsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save browser settings' }));
  await screen.findByText('Browser settings saved. No browser was started.');
  expect(requests).toEqual([
    { url: '/api/agent/browser', method: 'GET', body: undefined },
    { url: '/api/agent/browser', method: 'PUT', body: JSON.stringify(defaults) },
  ]);
});
