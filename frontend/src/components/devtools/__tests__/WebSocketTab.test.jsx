import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTab } from '../WebSocketTab';
import { apiFetch } from '../../../utils/api';
import userEvent from '@testing-library/user-event';

vi.mock('../../../utils/api', () => ({ apiFetch: vi.fn() }));

const connections = [
  { id: 'first-fixture', url: 'ws://localhost:4173/first', status: 'connected', timestamp: 1000 },
  { id: 'second-fixture', url: 'ws://localhost:4173/second', status: 'closed', timestamp: 2000 },
];
const messages = [
  { id: 'sent-fixture', connectionId: 'first-fixture', direction: 'sent', format: 'text', data: 'sent marker', timestamp: 1100, size: 11 },
  { id: 'received-fixture', connectionId: 'second-fixture', direction: 'received', format: 'text', data: 'received marker', timestamp: 2100, size: 15 },
];

const response = url => {
  const params = new URL(url, 'http://fixture').searchParams;
  return { ok: true, json: async () => ({ connections, messages: messages.filter(message => (!params.has('connectionId') || message.connectionId === params.get('connectionId')) && (!params.has('direction') || message.direction === params.get('direction'))) }) };
};
beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('WebSocketTab', () => {
  it('does not restore an in-flight snapshot after Clear succeeds', async () => {
    let finishOld;
    apiFetch.mockImplementation((_url, options) => options?.method === 'DELETE'
      ? Promise.resolve({ ok: true }) : new Promise(resolve => { finishOld = resolve; }));
    render(<WebSocketTab port={4173} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
    await act(async () => {});
    await act(async () => finishOld(response('/api/preview/4173/websockets')));
    expect(screen.getByText('Messages (0)')).toBeInTheDocument();
    expect(screen.queryByText('sent marker')).not.toBeInTheDocument();
  });

  it('reports clipboard failure in message details', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Synthetic denied')) } });
    apiFetch.mockResolvedValue(response('/api/preview/4173/websockets'));
    render(<WebSocketTab port={4173} />);
    fireEvent.click(await screen.findByText('sent marker'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy');
    expect(screen.getByRole('region', { name: 'Message details' })).toHaveTextContent('sent marker');
  });

  it('toggles a connection with Enter and Space and opens message details by keyboard', async () => {
    apiFetch.mockImplementation(async url => response(url));
    const user = userEvent.setup();
    render(<WebSocketTab port={4173} />);
    const connection = await screen.findByRole('button', { name: /ws:\/\/localhost:4173\/first/ });
    connection.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(connection).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByText('Messages (1)')).toBeInTheDocument();
    await user.keyboard(' ');
    await waitFor(() => expect(connection).toHaveAttribute('aria-pressed', 'false'));
    await screen.findByText('Messages (2)');
    screen.getByRole('button', { name: /sent marker/ }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Message Details' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(screen.getByRole('button', { name: /sent marker/ })).toHaveFocus();
  });

  it('preserves protocol, close metadata, JSON formatting and raw clipboard data', async () => {
    const data = '{"kind":"fixture","nested":{"ok":true}}';
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({
      connections: [{ ...connections[1], protocols: ['json', 'v2'], closeCode: 1000, closeReason: 'Fixture complete', error: 'Synthetic error' }],
      messages: [{ ...messages[0], data }],
    }) });
    render(<WebSocketTab port={4173} />);
    expect(await screen.findByText('Protocols: json, v2')).toBeInTheDocument();
    expect(screen.getByText('Close: 1000 Fixture complete')).toBeInTheDocument();
    expect(screen.getByText('Error: Synthetic error')).toBeInTheDocument();
    fireEvent.click(screen.getByText(data));
    expect(document.querySelector('pre').textContent).toBe(JSON.stringify(JSON.parse(data), null, 2));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(data);
  });

  it('leaves binary payload text unchanged in details', async () => {
    const data = '{"bytes":"fixture-base64"}';
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({
      connections, messages: [{ ...messages[0], format: 'binary', data }],
    }) });
    render(<WebSocketTab port={4173} />);
    fireEvent.click(await screen.findByText(data));
    expect(document.querySelector('pre').textContent).toBe(data);
    expect(screen.getByText('binary')).toBeInTheDocument();
  });
  it('renders the existing flat contract and requests connection and direction filters', async () => {
    apiFetch.mockImplementation(async url => response(url));
    render(<WebSocketTab port={4173} />);
    expect(await screen.findByText('Messages (2)')).toBeInTheDocument();
    expect(screen.getByText('sent marker')).toBeInTheDocument();
    expect(screen.getByText('received marker')).toBeInTheDocument();
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sent', exact: true }));
    expect(await screen.findByText('Messages (1)')).toBeInTheDocument();
    expect(screen.queryByText('received marker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }));
    await screen.findByText('Messages (2)');
    fireEvent.click(screen.getByText(connections[1].url));
    expect(await screen.findByText('received marker')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('sent marker')).not.toBeInTheDocument());
    expect(screen.queryByText('sent marker')).not.toBeInTheDocument();
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/preview/4173/websockets?', '/api/preview/4173/websockets?direction=sent',
      '/api/preview/4173/websockets?', '/api/preview/4173/websockets?connectionId=second-fixture',
    ]);
  });

  it('keeps telemetry when Clear fails and shows an honest error', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'DELETE'
      ? { ok: false, status: 405 } : response('/api/preview/4173/websockets'));
    render(<WebSocketTab port={4173} />);
    await screen.findByText('Messages (2)');
    fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear');
    expect(screen.getByText('Messages (2)')).toBeInTheDocument();
  });

  it('ignores a previous port response that completes after navigation', async () => {
    let finishOld;
    apiFetch.mockImplementation(url => url.includes('/4173/')
      ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ connections: [], messages: [] }) }));
    const { rerender } = render(<WebSocketTab port={4173} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    rerender(<WebSocketTab port={5173} />);
    await screen.findByText('Connections (0)');
    await act(async () => finishOld(response('/api/preview/4173/websockets')));
    expect(screen.getByText('Connections (0)')).toBeInTheDocument();
    expect(screen.queryByText('sent marker')).not.toBeInTheDocument();
  });

  it('cancels the active request and refresh timer when the tab unmounts', async () => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(async url => response(url));
    const { unmount } = render(<WebSocketTab port={4173} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1000' } });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const signal = apiFetch.mock.lastCall[1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
