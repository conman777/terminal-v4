import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Profiler } from 'react';
import { SystemResourcesView } from './SystemResourcesView';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));
vi.mock('../utils/api', () => ({ apiGet: apiGetMock }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'synthetic-token' }));
vi.mock('../utils/windowActivity', () => ({
  isWindowActive: () => true,
  subscribeWindowActivity: () => () => {}
}));

const gibibyte = 1024 ** 3;
const payload = {
  stats: {
    cpuPercent: 42,
    memoryUsed: 6 * gibibyte,
    memoryTotal: 8 * gibibyte,
    memoryPercent: 75,
    diskUsed: 15 * gibibyte,
    diskTotal: 20 * gibibyte,
    diskPercent: 75,
    uptime: 100,
    timestamp: 1700000000000
  }
};

beforeEach(() => {
  vi.stubGlobal('WebSocket', class { close() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  apiGetMock.mockImplementation(async (url) => {
    if (url === '/api/system/stats') return payload;
    if (url.startsWith('/api/system/stats/history')) return {
      history: [
        { cpuPercent: 20, memoryPercent: 60, diskPercent: 70, timestamp: 1700000000000 },
        { cpuPercent: 40, memoryPercent: 80, diskPercent: 75, timestamp: 1700000300000 }
      ]
    };
    if (url === '/api/health') return { ok: true };
    throw new Error(`Unexpected GET ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('SystemResourcesView Rust API contract', () => {
  it('samples every frame but publishes frame timing only once per second', async () => {
    let now = 0;
    let nextFrame;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', callback => { nextFrame = callback; return 1; });
    const onRender = vi.fn();
    render(<Profiler id="resources" onRender={onRender}><SystemResourcesView /></Profiler>);
    await screen.findByText('6.0 GB');
    const initialRenders = onRender.mock.calls.length;
    try {
      for (let frame = 0; frame < 60; frame += 1) {
        act(() => { now += 16; nextFrame(); });
      }
      expect(onRender.mock.calls.length - initialRenders).toBe(0);
      act(() => { now += 64; nextFrame(); });
      expect(screen.getByText('17ms')).toBeInTheDocument();
      expect(onRender.mock.calls.length - initialRenders).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('renders the wrapped flat stats payload with correct memory, CPU and disk units', async () => {
    render(<SystemResourcesView />);
    expect(await screen.findByText('6.0 GB')).toBeInTheDocument();
    expect(screen.getByText('2.0 GB')).toBeInTheDocument();
    expect(screen.getByText('8.0 GB')).toBeInTheDocument();
    expect(screen.getAllByText('42%')).toHaveLength(2);
    expect(screen.getByText('15.0 GB')).toBeInTheDocument();
    expect(screen.getByText('20.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Moderate Load')).toBeInTheDocument();
  });

  it('keeps fractional backend percentages readable in current and available values', async () => {
    const defaultImplementation = apiGetMock.getMockImplementation();
    apiGetMock.mockImplementation(async url => url === '/api/system/stats'
      ? { stats: { ...payload.stats, cpuPercent: 42.137413024902344, memoryPercent: 75.6789779663086 } }
      : defaultImplementation(url));
    const { container } = render(<SystemResourcesView />);
    expect(await screen.findByText('76%')).toBeInTheDocument();
    expect([...container.querySelectorAll('.sr-circular-value')].map(node => node.textContent)).toEqual(['76%', '42%']);
    const available = [...container.querySelectorAll('.sr-stat-row')].find(node => node.textContent.startsWith('Available'));
    expect(available.textContent).toBe('Available58%');
    expect(container.textContent).not.toMatch(/42\.137|75\.678|57\.862/);
  });

  it('renders canonical history fields and refetches when the selected range changes', async () => {
    const { container } = render(<SystemResourcesView />);
    expect(await screen.findByText('Avg: 70% · Max: 80%')).toBeInTheDocument();
    expect(screen.getByText('Avg: 30% · Max: 40%')).toBeInTheDocument();
    expect(screen.getByText('2 data points collected')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/NaN|undefined%/);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1h' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/system/stats/history?range=1h'));
  });

  it('explains when history is temporary while current metrics remain available', async () => {
    const defaultImplementation = apiGetMock.getMockImplementation();
    apiGetMock.mockImplementation(async url => url.startsWith('/api/system/stats/history')
      ? { history: [], historyError: 'Synthetic history preservation failure', historyPersistenceEnabled: false }
      : defaultImplementation(url));
    render(<SystemResourcesView />);
    expect(await screen.findByRole('status')).toHaveTextContent('History is temporary and will be lost when this server restarts. Current metrics remain available.');
    expect(screen.getByText('6.0 GB')).toBeInTheDocument();
  });

  it.each([false, true])('refreshes temporary history health after a successful retry (recovered=%s)', async recovered => {
    const defaultImplementation = apiGetMock.getMockImplementation();
    const recoveryNotice = 'Synthetic original history preserved for recovery';
    let historyHealth = recovered
      ? { historyError: recoveryNotice, historyPersistenceEnabled: true }
      : {};
    apiGetMock.mockImplementation(async url => url.startsWith('/api/system/stats/history')
      ? { history: [], ...historyHealth }
      : defaultImplementation(url));
    render(<SystemResourcesView />);
    expect(await screen.findByText('6.0 GB')).toBeInTheDocument();
    if (recovered) {
      expect(await screen.findByRole('status')).toHaveTextContent('Saved history was recovered. Earlier data was preserved for recovery.');
    }
    historyHealth = { historyError: 'Synthetic save failed; history is temporary', historyPersistenceEnabled: false };
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1h' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('History is temporary and will be lost when this server restarts. Current metrics remain available.'));
    historyHealth = recovered ? { historyError: recoveryNotice, historyPersistenceEnabled: true } : {};
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '6h' } });
    if (recovered) {
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved history was recovered. Earlier data was preserved for recovery.'));
    } else {
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    }
    expect(screen.getByText('6.0 GB')).toBeInTheDocument();
  });

});
