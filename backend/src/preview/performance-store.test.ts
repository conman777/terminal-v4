import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPerformanceMetrics,
  getPerformanceMetrics,
  ingestPerformanceMetrics,
  subscribePerformanceMetrics
} from './performance-store';

describe('performance-store', () => {
  const TEST_PORT = 55173;

  beforeEach(() => {
    clearPerformanceMetrics(TEST_PORT);
  });

  it('stores valid performance metrics by type', () => {
    const result = ingestPerformanceMetrics(TEST_PORT, [
      { type: 'coreWebVitals', timestamp: Date.now(), data: { lcp: 1500, fid: 25, cls: 0.05 } },
      { type: 'loadMetrics', timestamp: Date.now(), data: { domContentLoaded: 200, fullPageLoad: 800 } },
      { type: 'runtimeMetrics', timestamp: Date.now(), data: { fps: 60, memory: null, longTasks: [] } }
    ]);

    expect(result.accepted).toBe(3);
    expect(result.rejected).toBe(0);

    const stored = getPerformanceMetrics(TEST_PORT);
    expect(stored.coreWebVitals).toHaveLength(1);
    expect(stored.loadMetrics).toHaveLength(1);
    expect(stored.runtimeMetrics).toHaveLength(1);
  });

  it('rejects invalid metrics payload entries', () => {
    const result = ingestPerformanceMetrics(TEST_PORT, [
      { type: 'coreWebVitals', data: { lcp: 1234 } },
      { type: 'invalid-type', data: { x: 1 } },
      { type: 'runtimeMetrics', data: 'not-an-object' }
    ]);

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(2);
    expect(getPerformanceMetrics(TEST_PORT).coreWebVitals).toHaveLength(1);
  });

  it('notifies subscribers when metrics are ingested', () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribePerformanceMetrics(TEST_PORT, subscriber);

    ingestPerformanceMetrics(TEST_PORT, [
      { type: 'runtimeMetrics', timestamp: Date.now(), data: { fps: 58 } }
    ]);

    expect(subscriber).toHaveBeenCalledTimes(1);
    const payload = subscriber.mock.calls[0]?.[0];
    expect(payload.runtimeMetrics).toHaveLength(1);

    unsubscribe();
  });

  it('clears stored metrics', () => {
    ingestPerformanceMetrics(TEST_PORT, [
      { type: 'loadMetrics', timestamp: Date.now(), data: { domContentLoaded: 250 } }
    ]);
    expect(getPerformanceMetrics(TEST_PORT).loadMetrics).toHaveLength(1);
    clearPerformanceMetrics(TEST_PORT);
    expect(getPerformanceMetrics(TEST_PORT).loadMetrics).toHaveLength(0);
  });
});
