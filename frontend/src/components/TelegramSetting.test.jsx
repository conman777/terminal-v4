import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { TelegramSetting } from './TelegramSetting';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const json = body => ({ ok: true, json: async () => body });

beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('TelegramSetting', () => {
  it('connects a bot and shows how to pair the chat', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, options = {}) => options.method === 'PUT'
      ? json({ configured: true, botName: 'my_bot', paired: false, enabled: true, pairingCode: '123456' })
      : json({ configured: false }));
    render(<TelegramSetting />);
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: '123:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Send \/pair 123456 to @my_bot/)).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.find(([, options]) => options?.method === 'PUT')[1].body).toEqual({ token: '123:abc' });
  });

  it('shows a paired chat and can disconnect', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, options = {}) => options.method === 'DELETE'
      ? json({ configured: false }) : json({ configured: true, botName: 'my_bot', paired: true, enabled: true }));
    render(<TelegramSetting />);
    expect(await screen.findByText(/Paired with @my_bot/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByLabelText('Bot token')).toBeInTheDocument());
  });
});
