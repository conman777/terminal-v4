import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryChannelsPanel } from './DeliveryChannelsPanel';
import { validateDeliveryEndpoint } from '../utils/deliveryChannels';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

const reply = (value, status = 200) => ({ ok: status < 300, status, json: async () => value });
const status = (flags = {}) => reply({
  slack: { configured: Boolean(flags.slack) },
  discord: { configured: Boolean(flags.discord) },
  webhook: { configured: Boolean(flags.webhook) },
});
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const SECRET = 'a-long-signing-secret-1';

async function open(flags) {
  apiFetch.mockResolvedValueOnce(status(flags));
  const view = render(<DeliveryChannelsPanel />);
  await screen.findByRole('heading', { name: 'Slack' });
  return view;
}

beforeEach(() => apiFetch.mockReset());

describe('validateDeliveryEndpoint', () => {
  it.each([
    ['slack', '', '', 'Enter a valid webhook URL'],
    ['slack', 'not a url', '', 'Enter a valid webhook URL'],
    ['slack', 'http://hooks.slack.com/services/a', '', 'The webhook URL must use https'],
    ['slack', 'https://example.com/services/a', '', 'Use a Slack incoming webhook URL (hooks.slack.com/services/...)'],
    ['discord', 'https://example.com/api/webhooks/1', '', 'Use a Discord webhook URL (discord.com/api/webhooks/...)'],
    ['webhook', 'https://10.0.0.5/hook', SECRET, 'The webhook URL points at a private or local address'],
    ['webhook', 'https://localhost/hook', SECRET, 'The webhook URL points at a private or local address'],
    ['webhook', 'https://user:pw@example.com/hook', SECRET, 'The webhook URL must not contain credentials or a fragment'],
    ['webhook', 'https://example.com/hook', 'short', 'A signing secret of 16 to 256 characters is required'],
    ['webhook', 'https://example.com/hook', 'x'.repeat(257), 'A signing secret of 16 to 256 characters is required'],
  ])('rejects %s %s', (channel, url, secret, message) => {
    expect(validateDeliveryEndpoint(channel, url, secret)).toBe(message);
  });
  it.each([
    ['slack', SLACK, ''],
    ['discord', 'https://discord.com/api/webhooks/1/abc', ''],
    ['webhook', 'https://example.com/hook', SECRET],
  ])('accepts %s', (channel, url, secret) => {
    expect(validateDeliveryEndpoint(channel, url, secret)).toBe('');
  });
});

describe('DeliveryChannelsPanel', () => {
  it('shows only configured state and uses password inputs', async () => {
    await open({ discord: true });
    expect(screen.getByTestId('delivery-state-slack')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('delivery-state-discord')).toHaveTextContent('Configured');
    expect(screen.getByLabelText('Slack webhook URL')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Webhook signing secret')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Remove Discord' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Slack' })).not.toBeInTheDocument();
  });

  it('renders nothing when the route 404s', async () => {
    apiFetch.mockResolvedValueOnce(reply({}, 404));
    const { container } = render(<DeliveryChannelsPanel />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('reports unavailability on 404', async () => {
    const onUnavailable = vi.fn();
    apiFetch.mockResolvedValueOnce(reply({}, 404));
    render(<DeliveryChannelsPanel onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
  });

  it('validates inline and does not call the server', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Slack webhook URL'), { target: { value: 'https://example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Slack' }));
    expect(await screen.findByText('Use a Slack incoming webhook URL (hooks.slack.com/services/...)')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('saves, clears secrets and marks configured', async () => {
    await open();
    const url = screen.getByLabelText('Webhook URL');
    const secret = screen.getByLabelText('Webhook signing secret');
    fireEvent.change(url, { target: { value: 'https://example.com/hook' } });
    fireEvent.change(secret, { target: { value: SECRET } });
    apiFetch.mockResolvedValueOnce(reply({ channel: 'webhook', configured: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Webhook' }));
    await waitFor(() => expect(screen.getByTestId('delivery-state-webhook')).toHaveTextContent('Configured'));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/workspace/delivery-channels/webhook', { method: 'PUT', body: { url: 'https://example.com/hook', secret: SECRET } });
    expect(url).toHaveValue('');
    expect(secret).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('sends only the url for slack', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Slack webhook URL'), { target: { value: SLACK } });
    apiFetch.mockResolvedValueOnce(reply({ configured: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Slack' }));
    await waitFor(() => expect(screen.getByTestId('delivery-state-slack')).toHaveTextContent('Configured'));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/workspace/delivery-channels/slack', { method: 'PUT', body: { url: SLACK } });
  });

  it('shows a role=alert on save failure and stays unconfigured', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Slack webhook URL'), { target: { value: SLACK } });
    apiFetch.mockResolvedValueOnce(reply({ error: 'Delivery settings could not be saved' }, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Save Slack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery settings could not be saved');
    expect(screen.getByTestId('delivery-state-slack')).toHaveTextContent('Not configured');
  });

  it('removes a channel and reports failures', async () => {
    await open({ slack: true });
    apiFetch.mockResolvedValueOnce(reply({ error: 'nope' }, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Slack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    apiFetch.mockResolvedValueOnce(reply({ configured: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Slack' }));
    await waitFor(() => expect(screen.getByTestId('delivery-state-slack')).toHaveTextContent('Not configured'));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/workspace/delivery-channels/slack', { method: 'DELETE' });
  });

  it('shows an alert when loading fails', async () => {
    apiFetch.mockResolvedValueOnce(reply({ error: 'boom' }, 500));
    render(<DeliveryChannelsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load delivery channels');
  });
});
