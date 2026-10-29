import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ApiSettingsModal from './ApiSettingsModal';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPatch: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../utils/api', () => api);
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'synthetic', username: 'fixture' } }) }));
vi.mock('./PasskeyManager', () => ({ default: () => null }));
const options = () => ({ isOpen: true, onClose: vi.fn() });
beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset());
  api.apiGet.mockImplementation(async path => path === '/api/settings' ? { hasGroqApiKey: false } : { keys: [] });
});

it('shows vault load failure instead of an empty vault and retries independently of the Groq draft', async () => {
  let vaultAttempts = 0;
  api.apiGet.mockImplementation(async path => {
    if (path === '/api/settings') return { hasGroqApiKey: false };
    if (++vaultAttempts === 1) throw new Error('Synthetic vault unavailable');
    return { keys: [{ id: 'fixture', keyName: 'Synthetic key', keyValue: '****test' }] };
  });
  render(<ApiSettingsModal {...options()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic vault unavailable');
  expect(screen.queryByText('No keys stored yet.')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Groq API Key'), { target: { value: 'synthetic-unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading vault' }));
  expect(await screen.findByText('Synthetic key')).toBeVisible();
  expect(screen.getByLabelText('Groq API Key')).toHaveValue('synthetic-unsaved');
});

it('makes a settings load failure retryable and does not enable an unverified key removal', async () => {
  api.apiGet.mockImplementationOnce(async () => { throw new Error('Synthetic settings unavailable'); });
  render(<ApiSettingsModal {...options()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic settings unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading API settings' }));
  expect(await screen.findByLabelText('Groq API Key')).toBeEnabled();
});

it('ignores a save completion from a closed opening and preserves the new draft', async () => {
  let finish;
  api.apiPatch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = options();
  const view = render(<ApiSettingsModal {...props} />);
  fireEvent.change(await screen.findByLabelText('Groq API Key'), { target: { value: 'synthetic-old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
  view.rerender(<ApiSettingsModal {...props} isOpen={false} />);
  view.rerender(<ApiSettingsModal {...props} />);
  const input = await screen.findByLabelText('Groq API Key');
  fireEvent.change(input, { target: { value: 'synthetic-new-draft' } });
  await act(async () => finish({ success: true }));
  expect(input).toHaveValue('synthetic-new-draft');
  expect(screen.queryByText('API key settings saved successfully')).not.toBeInTheDocument();
  expect(api.apiGet.mock.calls.filter(([path]) => path === '/api/settings')).toHaveLength(3);
});

it('locks a vault draft during saving and retains it after failure', async () => {
  let reject;
  api.apiPost.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  render(<ApiSettingsModal {...options()} />);
  fireEvent.click(await screen.findByRole('button', { name: '+ Add Key' }));
  fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Synthetic key' } });
  fireEvent.change(screen.getByLabelText('Key value'), { target: { value: 'synthetic-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(screen.getByLabelText('Key value')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await act(async () => reject(new Error('Synthetic vault save unavailable')));
  expect(screen.getByLabelText('Key value')).toHaveValue('synthetic-value');
  expect(screen.getByLabelText('Key value')).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Synthetic vault save unavailable');
});

it('owns keyboard focus while open and restores the opener on Escape', async () => {
  const props = options();
  const view = render(<><button>Account fixture</button><ApiSettingsModal {...props} isOpen={false} /></>);
  const opener = screen.getByRole('button', { name: 'Account fixture' });
  opener.focus();
  view.rerender(<><button>Account fixture</button><ApiSettingsModal {...props} /></>);
  const close = screen.getAllByRole('button', { name: 'Close', exact: true })[0];
  expect(close).toHaveFocus();
  await screen.findByLabelText('Groq API Key');
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(screen.getAllByRole('button', { name: 'Close', exact: true }).at(-1)).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledOnce();
  view.rerender(<><button>Account fixture</button><ApiSettingsModal {...props} isOpen={false} /></>);
  await waitFor(() => expect(opener).toHaveFocus());
});

it('keeps write ownership across dismissal so a reopened form cannot race an older pending save', async () => {
  let finish;
  api.apiPatch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = options();
  const view = render(<ApiSettingsModal {...props} />);
  fireEvent.change(await screen.findByLabelText('Groq API Key'), { target: { value: 'synthetic-old-write' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
  view.rerender(<ApiSettingsModal {...props} isOpen={false} />);
  view.rerender(<ApiSettingsModal {...props} />);
  expect(await screen.findByLabelText('Groq API Key')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Groq API Key'), { target: { value: 'synthetic-next-write' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
  expect(api.apiPatch).toHaveBeenCalledTimes(1);
  await act(async () => finish({ success: true }));
  await waitFor(() => expect(screen.getByLabelText('Groq API Key')).toBeEnabled());
});
