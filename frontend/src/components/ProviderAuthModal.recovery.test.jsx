import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProviderAuthModal } from './ProviderAuthModal';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(), apiPost: vi.fn() }));
vi.mock('../utils/api', () => api);
const providers = [{ id: 'fixture', label: 'Synthetic provider', status: 'auth-required', configured: false, methods: ['api-key'] }];
const methods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeAll(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.open = true; } },
  close: { configurable: true, value() { this.open = false; } },
}));
afterAll(() => { for (const key of ['showModal', 'close']) { if (methods[key]) Object.defineProperty(HTMLDialogElement.prototype, key, methods[key]); else delete HTMLDialogElement.prototype[key]; } });
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); api.apiGet.mockResolvedValue({ providers }); });

it('offers a status retry after failure without requiring the user to dismiss the dialog', async () => {
  api.apiGet.mockRejectedValueOnce(new Error('Synthetic status unavailable'));
  render(<ProviderAuthModal isOpen onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic status unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh provider status' }));
  expect(await screen.findByLabelText('Synthetic provider API key')).toBeEnabled();
});

it('ignores a completed save from an earlier opening and keeps the new key draft', async () => {
  let finish;
  api.apiPut.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = { isOpen: true, onClose: vi.fn() };
  const view = render(<ProviderAuthModal {...props} />);
  fireEvent.change(await screen.findByLabelText('Synthetic provider API key'), { target: { value: 'synthetic-old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(screen.getByLabelText('Synthetic provider API key')).toBeDisabled();
  view.rerender(<ProviderAuthModal {...props} isOpen={false} />);
  view.rerender(<ProviderAuthModal {...props} />);
  fireEvent.change(await screen.findByLabelText('Synthetic provider API key'), { target: { value: 'synthetic-new' } });
  await act(async () => finish({ configured: true }));
  expect(screen.getByLabelText('Synthetic provider API key')).toHaveValue('synthetic-new');
  expect(screen.queryByText(/saved securely/)).not.toBeInTheDocument();
  expect(api.apiGet).toHaveBeenCalledTimes(3);
});

it('copies native setup commands for structured conversations instead of sending invalid PTY input', async () => {
  api.apiGet.mockResolvedValue({ providers: [{ id: 'codex', label: 'Codex', status: 'ready', methods: ['oauth'], command: 'codex login' }] });
  const writeText = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<ProviderAuthModal isOpen onClose={vi.fn()} sessionId="ss-synthetic-conversation" />);
  await screen.findByText('codex login');
  expect(screen.queryByRole('button', { name: 'Run in current terminal' })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Copy login command' }));
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith('codex login');
  expect(api.apiPost).not.toHaveBeenCalled();
});

it('blocks a new provider write after reopening until the older write settles', async () => {
  let finish;
  api.apiPut.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = { isOpen: true, onClose: vi.fn() };
  const view = render(<ProviderAuthModal {...props} />);
  fireEvent.change(await screen.findByLabelText('Synthetic provider API key'), { target: { value: 'synthetic-old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  view.rerender(<ProviderAuthModal {...props} isOpen={false} />);
  view.rerender(<ProviderAuthModal {...props} />);
  expect(await screen.findByLabelText('Synthetic provider API key')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Synthetic provider API key'), { target: { value: 'synthetic-new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(api.apiPut).toHaveBeenCalledTimes(1);
  await act(async () => finish({ configured: true }));
});
