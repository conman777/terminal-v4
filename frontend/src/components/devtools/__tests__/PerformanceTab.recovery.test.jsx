import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTab } from '../PerformanceTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../utils/auth', () => ({ getAccessToken: () => 'synthetic-token' }));
const metrics = lcp => ({ coreWebVitals: [{ data: { lcp } }], loadMetrics: [], runtimeMetrics: [] });
const response = lcp => ({ ok: true, json: async () => ({ metrics: metrics(lcp) }) });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('PerformanceTab request ownership', () => {
  it('keeps a live sample that arrives while an older refresh snapshot is pending', async () => {
    const sockets = [];
    vi.stubGlobal('WebSocket', class { constructor() { this.close = vi.fn(); sockets.push(this); } });
    const refresh = deferred();
    apiFetch.mockResolvedValueOnce(response(1800)).mockReturnValueOnce(refresh.promise);
    render(<PerformanceTab port={4173} />);
    await screen.findByText('1800');
    fireEvent.click(screen.getByRole('button', { name: 'Start Live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    act(() => sockets[0].onmessage({ data: JSON.stringify({ type: 'performance-update', metrics: metrics(1200) }) }));
    expect(screen.getByText('1200')).toBeInTheDocument();
    await act(async () => refresh.resolve(response(2400)));
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.queryByText('2400')).not.toBeInTheDocument();
  });
  it('ignores old-port results and resets a prior unsupported state on port change', async () => {
    const old = deferred();
    apiFetch.mockReturnValueOnce(old.promise).mockResolvedValue(response(1750));
    const view = render(<PerformanceTab port={4173} />);
    view.rerender(<PerformanceTab port={5173} />);
    await screen.findByText('1750');
    await act(async () => old.resolve({ status: 404 }));
    expect(screen.getByText('1750')).toBeInTheDocument();
    expect(screen.queryByText('Performance monitoring not available')).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce({ status: 404 });
    view.rerender(<PerformanceTab port={6173} />);
    await screen.findByText('Performance monitoring not available');
    view.rerender(<PerformanceTab port={7173} />);
    expect(await screen.findByText('1750')).toBeInTheDocument();
  });

  it('keeps the newest refresh result when earlier requests finish later', async () => {
    const old = deferred();
    apiFetch.mockReturnValueOnce(old.promise).mockResolvedValue(response(1700));
    render(<PerformanceTab port={4173} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    await screen.findByText('1700');
    await act(async () => old.resolve(response(3800)));
    expect(screen.queryByText('3800')).not.toBeInTheDocument();
    expect(screen.getByText('1700')).toBeInTheDocument();
  });

  it('preserves visible metrics on failed Clear and reports a recoverable error', async () => {
    apiFetch.mockResolvedValueOnce(response(1900)).mockResolvedValueOnce({ ok: false, status: 405 });
    render(<PerformanceTab port={4173} />);
    await screen.findByText('1900');
    fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear');
    expect(screen.getByText('1900')).toBeInTheDocument();
  });

  it('reports a temporary failure and recovers through Refresh', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Synthetic offline')).mockResolvedValue(response(1600));
    render(<PerformanceTab port={4173} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    await screen.findByText('1600');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not request an undefined port and aborts an active fetch on unmount', async () => {
    apiFetch.mockResolvedValue(response(1800));
    const view = render(<PerformanceTab />);
    expect(apiFetch).not.toHaveBeenCalled();
    view.rerender(<PerformanceTab port={4173} />);
    await screen.findByText('1800');
    const signal = apiFetch.mock.lastCall[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('ignores a retired stream close and late update after switching preview ports', async () => {
    const sockets = [];
    vi.stubGlobal('WebSocket', class {
      constructor() { this.close = vi.fn(); sockets.push(this); }
    });
    apiFetch.mockResolvedValue(response(1800));
    const view = render(<PerformanceTab port={4173} />);
    await screen.findByText('1800');
    fireEvent.click(screen.getByRole('button', { name: 'Start Live' }));
    const oldMessage = sockets[0].onmessage;
    const oldClose = sockets[0].onclose;
    view.rerender(<PerformanceTab port={5173} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Live' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Start Live' }));
    act(() => {
      oldMessage({ data: JSON.stringify({ type: 'performance-update', metrics: metrics(9999) }) });
      oldClose();
    });
    expect(screen.queryByText('9999')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
