import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackPerformanceMetric,
  getPerformanceMetrics,
  clearPerformanceMetrics,
  type PerformanceMetric,
  type CoreWebVitals,
  type LoadMetrics,
  type RuntimeMetrics
} from './performance-service';

describe('performance-service', () => {
  const testPort = 9999;

  beforeEach(() => {
    clearPerformanceMetrics(testPort);
  });

  describe('Core Web Vitals', () => {
    it('tracks LCP (Largest Contentful Paint)', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: {
          lcp: 2500,
          fid: null,
          cls: null
        } as CoreWebVitals
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.coreWebVitals).toHaveLength(1);
      expect(metrics.coreWebVitals[0].data.lcp).toBe(2500);
    });

    it('tracks FID (First Input Delay)', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: {
          lcp: null,
          fid: 100,
          cls: null
        } as CoreWebVitals
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.coreWebVitals).toHaveLength(1);
      expect(metrics.coreWebVitals[0].data.fid).toBe(100);
    });

    it('tracks CLS (Cumulative Layout Shift)', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: {
          lcp: null,
          fid: null,
          cls: 0.05
        } as CoreWebVitals
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.coreWebVitals).toHaveLength(1);
      expect(metrics.coreWebVitals[0].data.cls).toBe(0.05);
    });

    it('tracks all Core Web Vitals together', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: {
          lcp: 2400,
          fid: 80,
          cls: 0.03
        } as CoreWebVitals
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.coreWebVitals).toHaveLength(1);
      expect(metrics.coreWebVitals[0].data).toEqual({
        lcp: 2400,
        fid: 80,
        cls: 0.03
      });
    });
  });

  describe('Load Metrics', () => {
    it('tracks DOM Content Loaded and Full Page Load', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'load',
        data: {
          domContentLoaded: 1200,
          fullPageLoad: 2500,
          timeToInteractive: null
        } as LoadMetrics
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.loadMetrics).toHaveLength(1);
      expect(metrics.loadMetrics[0].data.domContentLoaded).toBe(1200);
      expect(metrics.loadMetrics[0].data.fullPageLoad).toBe(2500);
    });

    it('tracks Time to Interactive (TTI)', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'load',
        data: {
          domContentLoaded: 1200,
          fullPageLoad: 2500,
          timeToInteractive: 3000
        } as LoadMetrics
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.loadMetrics).toHaveLength(1);
      expect(metrics.loadMetrics[0].data.timeToInteractive).toBe(3000);
    });
  });

  describe('Runtime Metrics', () => {
    it('tracks FPS (Frames Per Second)', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'runtime',
        data: {
          fps: 58.5,
          memory: null,
          longTasks: []
        } as RuntimeMetrics
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.runtimeMetrics).toHaveLength(1);
      expect(metrics.runtimeMetrics[0].data.fps).toBe(58.5);
    });

    it('tracks memory usage', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'runtime',
        data: {
          fps: null,
          memory: {
            usedJSHeapSize: 25000000,
            totalJSHeapSize: 50000000,
            jsHeapSizeLimit: 2000000000
          },
          longTasks: []
        } as RuntimeMetrics
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.runtimeMetrics).toHaveLength(1);
      expect(metrics.runtimeMetrics[0].data.memory).toEqual({
        usedJSHeapSize: 25000000,
        totalJSHeapSize: 50000000,
        jsHeapSizeLimit: 2000000000
      });
    });

    it('tracks long tasks', () => {
      const metric: PerformanceMetric = {
        port: testPort,
        timestamp: Date.now(),
        type: 'runtime',
        data: {
          fps: null,
          memory: null,
          longTasks: [
            { duration: 120, startTime: 5000 },
            { duration: 250, startTime: 8000 }
          ]
        } as RuntimeMetrics
      };

      trackPerformanceMetric(metric);
      const metrics = getPerformanceMetrics(testPort);

      expect(metrics.runtimeMetrics).toHaveLength(1);
      expect(metrics.runtimeMetrics[0].data.longTasks).toHaveLength(2);
      expect(metrics.runtimeMetrics[0].data.longTasks[0].duration).toBe(120);
      expect(metrics.runtimeMetrics[0].data.longTasks[1].duration).toBe(250);
    });
  });

  describe('Metric Storage', () => {
    it('stores metrics separately by port', () => {
      trackPerformanceMetric({
        port: 8000,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: { lcp: 2000, fid: null, cls: null } as CoreWebVitals
      });

      trackPerformanceMetric({
        port: 8001,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: { lcp: 3000, fid: null, cls: null } as CoreWebVitals
      });

      const metrics8000 = getPerformanceMetrics(8000);
      const metrics8001 = getPerformanceMetrics(8001);

      expect(metrics8000.coreWebVitals).toHaveLength(1);
      expect(metrics8001.coreWebVitals).toHaveLength(1);
      expect(metrics8000.coreWebVitals[0].data.lcp).toBe(2000);
      expect(metrics8001.coreWebVitals[0].data.lcp).toBe(3000);

      clearPerformanceMetrics(8000);
      clearPerformanceMetrics(8001);
    });

    it('limits metrics to MAX_METRICS_PER_TYPE (100)', () => {
      // Add 120 metrics
      for (let i = 0; i < 120; i++) {
        trackPerformanceMetric({
          port: testPort,
          timestamp: Date.now() + i,
          type: 'runtime',
          data: {
            fps: 60 - i,
            memory: null,
            longTasks: []
          } as RuntimeMetrics
        });
      }

      const metrics = getPerformanceMetrics(testPort);
      expect(metrics.runtimeMetrics).toHaveLength(100);
      // Should keep the most recent 100
      expect(metrics.runtimeMetrics[0].data.fps).toBe(-40); // 60 - 20
      expect(metrics.runtimeMetrics[99].data.fps).toBe(-59); // 60 - 119
    });

    it('returns empty arrays for port with no metrics', () => {
      const metrics = getPerformanceMetrics(12345);
      expect(metrics.coreWebVitals).toEqual([]);
      expect(metrics.loadMetrics).toEqual([]);
      expect(metrics.runtimeMetrics).toEqual([]);
    });
  });

  describe('clearPerformanceMetrics', () => {
    it('clears all metrics for a port', () => {
      trackPerformanceMetric({
        port: testPort,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: { lcp: 2000, fid: null, cls: null } as CoreWebVitals
      });

      trackPerformanceMetric({
        port: testPort,
        timestamp: Date.now(),
        type: 'load',
        data: {
          domContentLoaded: 1200,
          fullPageLoad: 2500,
          timeToInteractive: null
        } as LoadMetrics
      });

      let metrics = getPerformanceMetrics(testPort);
      expect(metrics.coreWebVitals).toHaveLength(1);
      expect(metrics.loadMetrics).toHaveLength(1);

      clearPerformanceMetrics(testPort);

      metrics = getPerformanceMetrics(testPort);
      expect(metrics.coreWebVitals).toEqual([]);
      expect(metrics.loadMetrics).toEqual([]);
      expect(metrics.runtimeMetrics).toEqual([]);
    });

    it('does not affect other ports', () => {
      trackPerformanceMetric({
        port: 8000,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: { lcp: 2000, fid: null, cls: null } as CoreWebVitals
      });

      trackPerformanceMetric({
        port: 8001,
        timestamp: Date.now(),
        type: 'core-web-vitals',
        data: { lcp: 3000, fid: null, cls: null } as CoreWebVitals
      });

      clearPerformanceMetrics(8000);

      const metrics8000 = getPerformanceMetrics(8000);
      const metrics8001 = getPerformanceMetrics(8001);

      expect(metrics8000.coreWebVitals).toEqual([]);
      expect(metrics8001.coreWebVitals).toHaveLength(1);

      clearPerformanceMetrics(8001);
    });
  });

  describe('Filtering by time', () => {
    it('returns metrics after a given timestamp', () => {
      const now = Date.now();

      trackPerformanceMetric({
        port: testPort,
        timestamp: now,
        type: 'runtime',
        data: { fps: 60, memory: null, longTasks: [] } as RuntimeMetrics
      });

      trackPerformanceMetric({
        port: testPort,
        timestamp: now + 1000,
        type: 'runtime',
        data: { fps: 58, memory: null, longTasks: [] } as RuntimeMetrics
      });

      trackPerformanceMetric({
        port: testPort,
        timestamp: now + 2000,
        type: 'runtime',
        data: { fps: 59, memory: null, longTasks: [] } as RuntimeMetrics
      });

      const allMetrics = getPerformanceMetrics(testPort);
      expect(allMetrics.runtimeMetrics).toHaveLength(3);

      const recentMetrics = getPerformanceMetrics(testPort, now + 1000);
      expect(recentMetrics.runtimeMetrics).toHaveLength(2);
      expect(recentMetrics.runtimeMetrics[0].data.fps).toBe(58);
      expect(recentMetrics.runtimeMetrics[1].data.fps).toBe(59);
    });
  });
});
