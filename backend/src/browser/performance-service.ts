/**
 * Performance Service
 *
 * Tracks and stores performance metrics for preview applications.
 * Monitors Core Web Vitals (LCP, FID, CLS), load metrics, and runtime performance.
 */

// Core Web Vitals
export interface CoreWebVitals {
  lcp: number | null; // Largest Contentful Paint (ms)
  fid: number | null; // First Input Delay (ms)
  cls: number | null; // Cumulative Layout Shift (score)
}

// Load Metrics
export interface LoadMetrics {
  domContentLoaded: number; // DOM Content Loaded (ms)
  fullPageLoad: number; // Full Page Load (ms)
  timeToInteractive: number | null; // Time to Interactive (ms)
}

// Runtime Metrics
export interface RuntimeMetrics {
  fps: number | null; // Frames per second
  memory: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  } | null;
  longTasks: Array<{
    duration: number;
    startTime: number;
  }>;
}

export type PerformanceMetricType = 'core-web-vitals' | 'load' | 'runtime';

export interface PerformanceMetric {
  port: number;
  timestamp: number;
  type: PerformanceMetricType;
  data: CoreWebVitals | LoadMetrics | RuntimeMetrics;
}

interface PerformanceMetrics {
  coreWebVitals: Array<PerformanceMetric & { data: CoreWebVitals }>;
  loadMetrics: Array<PerformanceMetric & { data: LoadMetrics }>;
  runtimeMetrics: Array<PerformanceMetric & { data: RuntimeMetrics }>;
  latestTimestamp: number;  // Cache latest timestamp
}

// Storage: Map<port, PerformanceMetrics>
const metricsStore = new Map<number, PerformanceMetrics>();

// Maximum metrics to store per type per port
const MAX_METRICS_PER_TYPE = 100;

/**
 * Initialize empty metrics for a port
 */
function initializeMetrics(port: number): PerformanceMetrics {
  const metrics: PerformanceMetrics = {
    coreWebVitals: [],
    loadMetrics: [],
    runtimeMetrics: [],
    latestTimestamp: 0
  };
  metricsStore.set(port, metrics);
  return metrics;
}

/**
 * Get metrics for a port
 */
function getMetricsForPort(port: number): PerformanceMetrics {
  let metrics = metricsStore.get(port);
  if (!metrics) {
    metrics = initializeMetrics(port);
  }
  return metrics;
}

/**
 * Trim metrics array to MAX_METRICS_PER_TYPE
 * Uses slice for better performance instead of splice
 */
function trimMetrics<T>(array: T[]): T[] {
  if (array.length > MAX_METRICS_PER_TYPE) {
    return array.slice(-MAX_METRICS_PER_TYPE);
  }
  return array;
}

/**
 * Track a performance metric
 */
export function trackPerformanceMetric(metric: PerformanceMetric): void {
  // Validate metric object
  if (!metric || typeof metric !== 'object') {
    throw new Error('Invalid metric: must be an object');
  }

  // Validate port
  if (typeof metric.port !== 'number' || metric.port <= 0 || metric.port > 65535) {
    throw new Error(`Invalid metric port: ${metric.port} (must be 1-65535)`);
  }

  // Validate type
  if (!metric.type || typeof metric.type !== 'string') {
    throw new Error('Invalid metric: type is required');
  }

  const validTypes: PerformanceMetricType[] = ['core-web-vitals', 'load', 'runtime'];
  if (!validTypes.includes(metric.type)) {
    throw new Error(`Invalid metric type: ${metric.type} (must be one of ${validTypes.join(', ')})`);
  }

  // Validate data
  if (!metric.data || typeof metric.data !== 'object') {
    throw new Error('Invalid metric: data is required');
  }

  // Validate timestamp
  if (typeof metric.timestamp !== 'number' || metric.timestamp <= 0) {
    throw new Error('Invalid metric: timestamp must be a positive number');
  }

  const metrics = getMetricsForPort(metric.port);

  // Update cached timestamp
  if (metric.timestamp > metrics.latestTimestamp) {
    metrics.latestTimestamp = metric.timestamp;
  }

  switch (metric.type) {
    case 'core-web-vitals':
      metrics.coreWebVitals.push(metric as PerformanceMetric & { data: CoreWebVitals });
      metrics.coreWebVitals = trimMetrics(metrics.coreWebVitals);
      break;
    case 'load':
      metrics.loadMetrics.push(metric as PerformanceMetric & { data: LoadMetrics });
      metrics.loadMetrics = trimMetrics(metrics.loadMetrics);
      break;
    case 'runtime':
      metrics.runtimeMetrics.push(metric as PerformanceMetric & { data: RuntimeMetrics });
      metrics.runtimeMetrics = trimMetrics(metrics.runtimeMetrics);
      break;
  }
}

/**
 * Get all performance metrics for a port
 * Optionally filter by timestamp (only return metrics after this time)
 */
export function getPerformanceMetrics(port: number, since?: number): PerformanceMetrics {
  const metrics = getMetricsForPort(port);

  if (since === undefined) {
    return {
      coreWebVitals: [...metrics.coreWebVitals],
      loadMetrics: [...metrics.loadMetrics],
      runtimeMetrics: [...metrics.runtimeMetrics]
    };
  }

  return {
    coreWebVitals: metrics.coreWebVitals.filter(m => m.timestamp > since),
    loadMetrics: metrics.loadMetrics.filter(m => m.timestamp > since),
    runtimeMetrics: metrics.runtimeMetrics.filter(m => m.timestamp > since)
  };
}

/**
 * Clear all performance metrics for a port
 */
export function clearPerformanceMetrics(port: number): void {
  metricsStore.delete(port);
}

/**
 * Get latest timestamp for a port (for streaming updates)
 * Uses cached value for O(1) performance instead of O(n) linear scan
 */
export function getLatestMetricTimestamp(port: number): number {
  const metrics = metricsStore.get(port);
  if (!metrics) return 0;
  return metrics.latestTimestamp || 0;
}
