import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentBrowserSettingsPanel } from './AgentBrowserSettingsPanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const defaults = { enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] };
const response = (body, ok = true) => ({ ok, json: async () => body });
const setup = async (config = defaults) => {
  apiFetch.mockResolvedValueOnce(response(config));
  const result = render(<AgentBrowserSettingsPanel />);
  await screen.findByRole('button', { name: 'Save browser settings' });
  return result;
};
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save browser settings' }));

beforeEach(() => apiFetch.mockReset());

describe('AgentBrowserSettingsPanel', () => {
  it('loads disabled configuration and explains isolated approved actions without starting a browser', async () => {
    await setup();
    expect(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Run browser without a visible window' })).toBeChecked();
    expect(screen.getByLabelText('Action timeout (seconds)')).toHaveValue(15);
    expect(screen.getByLabelText('Allowed origins')).toHaveValue('');
    expect(screen.getByText(/separate disposable browser profile/i)).toBeInTheDocument();
    expect(screen.getByText(/each browser action requires explicit approval/i)).toBeInTheDocument();
    expect(apiFetch.mock.calls).toEqual([['/api/agent/browser', { home: true, signal: expect.any(AbortSignal) }]]);
  });

  it('normalizes exact origins and saves the configuration only after explicit submit', async () => {
    await setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run browser without a visible window' }));
    fireEvent.change(screen.getByLabelText('Browser executable path'), { target: { value: ' /opt/fixture/chromium ' } });
    fireEvent.change(screen.getByLabelText('Action timeout (seconds)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Allowed origins'), { target: { value: 'https://EXAMPLE.test:443/\nhttp://127.0.0.1:3042\nhttps://example.test\n' } });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const config = { enabled: true, executable: '/opt/fixture/chromium', headless: false, timeoutSeconds: 30, allowedOrigins: ['https://example.test', 'http://127.0.0.1:3042'] };
    apiFetch.mockResolvedValueOnce(response(config));
    save();
    expect(await screen.findByText('Browser settings saved. No browser was started.')).toBeInTheDocument();
    expect(apiFetch.mock.calls[1]).toEqual(['/api/agent/browser', { home: true, method: 'PUT', body: config, signal: expect.any(AbortSignal) }]);
    expect(screen.getByLabelText('Allowed origins')).toHaveValue('https://example.test\nhttp://127.0.0.1:3042');
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it.each(['https://user:password@example.test', 'https://example.test/private', 'https://example.test/?token=synthetic', 'https://example.test/#private', 'https://example.test?', 'https://example.test#', 'file:///tmp/private', 'https://*.example.test', 'https://example\t.test'])('rejects non-origin input %s without sending a save', async origin => {
    await setup();
    fireEvent.change(screen.getByLabelText('Allowed origins'), { target: { value: origin } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/origin/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('limits the list to 64 unique origins', async () => {
    await setup();
    fireEvent.change(screen.getByLabelText('Allowed origins'), { target: { value: Array.from({ length: 65 }, (_, index) => `https://fixture-${index}.test`).join('\n') } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('64');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '61', '1.5', ''])('rejects invalid action timeout %s', async timeout => {
    await setup();
    fireEvent.change(screen.getByLabelText('Action timeout (seconds)'), { target: { value: timeout } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 60');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['chromium', '~/bin/chromium', 'C:chromium.exe', '/opt/browser\u0007'])('rejects an executable override that is not an absolute native path %s', async executable => {
    await setup();
    fireEvent.change(screen.getByLabelText('Browser executable path'), { target: { value: executable } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/absolute path/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps failed-save edits and permits retry after a server-side executable check fails', async () => {
    await setup();
    fireEvent.change(screen.getByLabelText('Browser executable path'), { target: { value: '/missing/chromium' } });
    apiFetch.mockResolvedValueOnce(response({ error: 'The configured executable does not exist.' }, false));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('does not exist');
    expect(screen.getByLabelText('Browser executable path')).toHaveValue('/missing/chromium');
    fireEvent.change(screen.getByLabelText('Browser executable path'), { target: { value: '' } });
    apiFetch.mockResolvedValueOnce(response(defaults));
    save();
    await screen.findByText('Browser settings saved. No browser was started.');
    expect(apiFetch.mock.calls[2][1].body.executable).toBeNull();
  });

  it('keeps the editor unavailable after a load failure until retry succeeds', async () => {
    apiFetch.mockResolvedValueOnce(response({ error: 'Saved browser configuration is unreadable.' }, false));
    render(<AgentBrowserSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unreadable');
    expect(screen.queryByRole('button', { name: 'Save browser settings' })).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response(defaults));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading browser settings' }));
    expect(await screen.findByRole('button', { name: 'Save browser settings' })).toBeEnabled();
  });

  it('does not overwrite malformed loaded configuration with defaults', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...defaults, allowedOrigins: 'https://fixture.test' }));
    render(<AgentBrowserSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid');
    expect(screen.queryByRole('button', { name: 'Save browser settings' })).not.toBeInTheDocument();
  });

  it('resets only unsaved edits and does not send a request for a reset', async () => {
    await setup({ ...defaults, allowedOrigins: ['http://127.0.0.1:3042'] });
    fireEvent.change(screen.getByLabelText('Allowed origins'), { target: { value: 'https://new.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved changes' }));
    expect(screen.getByLabelText('Allowed origins')).toHaveValue('http://127.0.0.1:3042');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('disables duplicate saves and aborts its pending request on unmount', async () => {
    const { unmount } = await setup();
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    save();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving browser settings…' })).toBeDisabled());
    const signal = apiFetch.mock.calls[1][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(defaults)));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

it('distinguishes saved browser settings from unconfirmed cleanup and retries the committed configuration', async () => {
  await setup();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' }));
  const committed = { ...defaults, enabled: true };
  apiFetch.mockResolvedValueOnce({ ...response({ error: 'Settings saved, but cleanup is unconfirmed. Retry Save.', settingsSaved: true, cleanupConfirmed: false, config: committed }, false), status: 503 });
  save();
  expect(await screen.findByRole('alert')).toHaveTextContent('Settings saved, but cleanup is unconfirmed.');
  expect(screen.getByText(/browser settings are saved.*cleanup is unconfirmed/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reset unsaved changes' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save browser settings' })).toBeEnabled();
  apiFetch.mockResolvedValueOnce(response(committed));save();
  await screen.findByText('Browser settings saved. No browser was started.');
  expect(apiFetch.mock.calls[2][1].body).toEqual(committed);
  expect(screen.queryByText(/browser settings are saved.*cleanup is unconfirmed/i)).not.toBeInTheDocument();
});

it('keeps edits available when a browser action temporarily blocks saving', async () => {
  await setup();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' }));
  apiFetch.mockResolvedValueOnce({ ...response({ error: 'Browser settings are busy with an active action; retry shortly' }, false), status: 503 });
  save();
  expect(await screen.findByRole('alert')).toHaveTextContent('retry shortly');
  expect(screen.getByRole('checkbox', { name: 'Enable browser tools for V4 agents' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Reset unsaved changes' })).toBeEnabled();
  expect(screen.queryByText(/browser settings are saved.*cleanup is unconfirmed/i)).not.toBeInTheDocument();
  apiFetch.mockResolvedValueOnce(response({ ...defaults, enabled: true }));
  save();
  await screen.findByText('Browser settings saved. No browser was started.');
});

it('explains that changed browser settings stop integrations and hold queued work without launching a browser', async () => {
  await setup();
  expect(screen.getByText(/changed settings.*stop.*integrations.*hold.*queued work/i)).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
