import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PerformanceTab } from '../PerformanceTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  apiFetch: vi.fn()
}));

vi.mock('../../../utils/auth', () => ({
  getAccessToken: vi.fn(() => null)
}));

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

describe('PerformanceTab', () => {
  const mockApiFetch = vi.mocked(apiFetch);

  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads metrics via authenticated API fetch', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        metrics: {
          coreWebVitals: [{ type: 'coreWebVitals', timestamp: Date.now(), data: { lcp: 1234, fid: null, cls: null } }],
          loadMetrics: [],
          runtimeMetrics: []
        }
      })
    });

    render(<PerformanceTab port={5173} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/preview/5173/performance');
    });
    expect(screen.getByText('Performance Monitor')).toBeInTheDocument();
    expect(screen.getByText(/LCP/)).toBeInTheDocument();
  });

  it('shows unavailable state on 404', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    });

    render(<PerformanceTab port={5173} />);

    await waitFor(() => {
      expect(screen.getByText('Performance monitoring not available')).toBeInTheDocument();
    });
  });

  it('applies websocket snapshot metrics when live mode starts', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        metrics: {
          coreWebVitals: [],
          loadMetrics: [],
          runtimeMetrics: []
        }
      })
    });

    render(<PerformanceTab port={5173} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText('Start Live'));
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].emit({
      type: 'performance-snapshot',
      metrics: {
        coreWebVitals: [{ type: 'coreWebVitals', timestamp: Date.now(), data: { lcp: 2500, fid: 50, cls: 0.12 } }],
        loadMetrics: [],
        runtimeMetrics: []
      }
    });

    await waitFor(() => {
      expect(screen.getByText(/2500/)).toBeInTheDocument();
    });
  });
});
