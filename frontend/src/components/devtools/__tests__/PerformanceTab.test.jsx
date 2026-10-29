import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTab } from '../PerformanceTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../utils/auth', () => ({ getAccessToken: () => 'synthetic-token' }));

const metrics = {
  coreWebVitals: [{ data: { lcp: 2100, fid: 150, cls: 0.3 } }],
  loadMetrics: [{ data: { domContentLoaded: 600, fullPageLoad: 900, timeToInteractive: 1200 } }],
  runtimeMetrics: [{ data: { fps: 58, memory: { usedJSHeapSize: 10485760, totalJSHeapSize: 20971520 }, longTasks: [{ startTime: 500, duration: 80 }] } }],
};

beforeEach(() => {
  apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ metrics }) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('PerformanceTab', () => {
  it('renders the existing metric values, units, thresholds, graph and long tasks', async () => {
    render(<PerformanceTab port={4173} />);
    await screen.findByText('2100');
    const cards = [...document.querySelectorAll('.performance-tab__metric')];
    expect(cards.map(card => card.textContent)).toEqual([
      'LCP (Largest Contentful Paint)2100msGood: ≤2500ms, Needs improvement: ≤4000ms',
      'FID (First Input Delay)150msGood: ≤100ms, Needs improvement: ≤300ms',
      'CLS (Cumulative Layout Shift)0.300Good: ≤0.1, Needs improvement: ≤0.25',
      'DOM Content Loaded600ms', 'Full Page Load900ms', 'Time to Interactive (TTI)1200ms',
      'FPS (Frames Per Second)58.0Target: 60 FPS', 'JS Heap Used10.0MBTotal: 20.0 MB',
    ]);
    expect(screen.getByRole('img', { name: 'FPS over time, last 1 samples' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Long tasks over 50 milliseconds' })).toHaveTextContent('500.00ms80.00ms');
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/preview/4173/performance', { signal: expect.any(AbortSignal) });
  });

  it('supports native keyboard refresh, JSON export and clear without submitting a parent form', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(event => event.preventDefault());
    const createObjectURL = vi.fn(() => 'blob:synthetic-report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<form onSubmit={submit}><PerformanceTab port={4173} /></form>);
    await screen.findByText('2100');
    screen.getByRole('button', { name: 'Refresh', exact: true }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await user.tab();
    expect(screen.getByRole('button', { name: 'Export', exact: true })).toHaveFocus();
    await user.keyboard(' ');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/json');
    expect(download.mock.instances[0].download).toMatch(/^performance-report-4173-\d+\.json$/);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-report');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/No performance metrics available/)).toBeInTheDocument();
    expect(apiFetch.mock.calls).toEqual([
      ['/api/preview/4173/performance', { signal: expect.any(AbortSignal) }], ['/api/preview/4173/performance', { signal: expect.any(AbortSignal) }],
      ['/api/preview/4173/performance', { method: 'DELETE' }],
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('exposes live state and preserves authenticated stream updates and socket cleanup', async () => {
    const sockets = [];
    vi.stubGlobal('WebSocket', class {
      constructor(url) { this.url = url; this.close = vi.fn(); sockets.push(this); }
    });
    const user = userEvent.setup();
    const view = render(<PerformanceTab port={4173} />);
    await screen.findByText('2100');
    const toggle = screen.getByRole('button', { name: 'Start Live' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    toggle.focus();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(sockets[0].url).toMatch(/\/api\/preview\/4173\/performance\/stream\?token=synthetic-token$/);
    act(() => sockets[0].onmessage({ data: JSON.stringify({ type: 'performance-update', metrics: {
      coreWebVitals: [], loadMetrics: [], runtimeMetrics: [{ data: { fps: 42 } }],
    } }) }));
    expect(await screen.findByText('42.0')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(sockets[0].close).toHaveBeenCalledOnce();
    await user.keyboard('{Enter}');
    view.unmount();
    expect(sockets[1].close).toHaveBeenCalledOnce();
  });

  it('renders the unavailable state for a missing endpoint', async () => {
    apiFetch.mockResolvedValue({ status: 404 });
    render(<PerformanceTab port={4173} />);
    expect(await screen.findByText('Performance monitoring not available')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Performance metrics' })).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([false, true])('keeps the Performance tab behind the existing feature flag (%s)', async enabled => {
    vi.stubEnv('VITE_ENABLE_PERFORMANCE_TAB', String(enabled));
    vi.resetModules();
    const { DevToolsPanel } = await import('../DevToolsPanel');
    render(<DevToolsPanel previewPort={4173} />);
    const tab = screen.queryByRole('button', { name: 'Performance', exact: true });
    expect(Boolean(tab)).toBe(enabled);
    if (enabled) {
      fireEvent.click(tab);
      expect(await screen.findByRole('heading', { name: 'Performance Monitor' })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('heading', { name: 'Performance Monitor' })).not.toBeInTheDocument();
      expect(apiFetch).not.toHaveBeenCalled();
    }
  });
});
