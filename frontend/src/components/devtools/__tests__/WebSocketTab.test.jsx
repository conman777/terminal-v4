import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebSocketTab } from '../WebSocketTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  apiFetch: vi.fn()
}));

describe('WebSocketTab', () => {
  const mockApiFetch = vi.mocked(apiFetch);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads websocket connections and messages', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        connections: [
          {
            id: 'conn-1234567890',
            status: 'connected',
            url: 'ws://localhost:5173/socket',
            timestamp: Date.now(),
            protocols: ['json']
          }
        ],
        messages: [
          {
            id: 'msg-1',
            connectionId: 'conn-1234567890',
            timestamp: Date.now(),
            direction: 'sent',
            format: 'text',
            size: 4,
            data: 'ping'
          }
        ]
      })
    });

    render(<WebSocketTab port={5173} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/preview/5173/websockets?');
    });
    expect(screen.getByText(/Connections \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Messages \(1\)/)).toBeInTheDocument();
  });

  it('shows unavailable state on 404', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    });

    render(<WebSocketTab port={5173} />);

    await waitFor(() => {
      expect(screen.getByText('WebSocket debugging not available')).toBeInTheDocument();
    });
  });

  it('clears logs through backend endpoint', async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ connections: [], messages: [] })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      });

    render(<WebSocketTab port={5173} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText('Clear'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/preview/5173/websockets', { method: 'DELETE' });
    });
  });
});
