export type PerformanceMetricType = 'coreWebVitals' | 'loadMetrics' | 'runtimeMetrics';

export interface PerformanceMetricEntry {
  type: PerformanceMetricType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface PerformanceMetricsBundle {
  coreWebVitals: PerformanceMetricEntry[];
  loadMetrics: PerformanceMetricEntry[];
  runtimeMetrics: PerformanceMetricEntry[];
}

interface PerformancePortStore extends PerformanceMetricsBundle {
  lastActivity: number;
}

export interface IngestPerformanceResult {
  accepted: number;
  rejected: number;
  metrics: PerformanceMetricsBundle;
}

type Subscriber = (metrics: PerformanceMetricsBundle) => void;

const storesByPort = new Map<number, PerformancePortStore>();
const subscribersByPort = new Map<number, Set<Subscriber>>();

const MAX_METRICS_PER_TYPE = 1000;
const MAX_DATA_BYTES = 64 * 1024;
const STALE_PORT_TIMEOUT_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;

function createEmptyBundle(): PerformanceMetricsBundle {
  return {
    coreWebVitals: [],
    loadMetrics: [],
    runtimeMetrics: []
  };
}

function cloneBundle(bundle: PerformanceMetricsBundle): PerformanceMetricsBundle {
  return {
    coreWebVitals: [...bundle.coreWebVitals],
    loadMetrics: [...bundle.loadMetrics],
    runtimeMetrics: [...bundle.runtimeMetrics]
  };
}

function trimBuffer(buffer: PerformanceMetricEntry[]): void {
  if (buffer.length <= MAX_METRICS_PER_TYPE) return;
  buffer.splice(0, buffer.length - MAX_METRICS_PER_TYPE);
}

function ensurePortStore(port: number): PerformancePortStore {
  let store = storesByPort.get(port);
  if (!store) {
    store = {
      ...createEmptyBundle(),
      lastActivity: Date.now()
    };
    storesByPort.set(port, store);
  }
  store.lastActivity = Date.now();
  return store;
}

function normalizeMetric(metric: Partial<PerformanceMetricEntry>): PerformanceMetricEntry | null {
  const type = metric.type;
  if (type !== 'coreWebVitals' && type !== 'loadMetrics' && type !== 'runtimeMetrics') {
    return null;
  }

  const dataValue = metric.data;
  if (!dataValue || typeof dataValue !== 'object' || Array.isArray(dataValue)) {
    return null;
  }

  // Bound payload size to avoid abuse from injected pages.
  let payloadSize = 0;
  try {
    payloadSize = Buffer.byteLength(JSON.stringify(dataValue), 'utf8');
  } catch {
    return null;
  }
  if (payloadSize > MAX_DATA_BYTES) {
    return null;
  }

  const timestamp =
    typeof metric.timestamp === 'number' && Number.isFinite(metric.timestamp) && metric.timestamp > 0
      ? Math.floor(metric.timestamp)
      : Date.now();

  return {
    type,
    timestamp,
    data: dataValue as Record<string, unknown>
  };
}

function appendMetric(store: PerformanceMetricsBundle, metric: PerformanceMetricEntry): void {
  if (metric.type === 'coreWebVitals') {
    store.coreWebVitals.push(metric);
    trimBuffer(store.coreWebVitals);
    return;
  }
  if (metric.type === 'loadMetrics') {
    store.loadMetrics.push(metric);
    trimBuffer(store.loadMetrics);
    return;
  }
  store.runtimeMetrics.push(metric);
  trimBuffer(store.runtimeMetrics);
}

function notifySubscribers(port: number, metrics: PerformanceMetricsBundle): void {
  const subscribers = subscribersByPort.get(port);
  if (!subscribers || subscribers.size === 0) return;
  for (const handler of subscribers) {
    try {
      handler(metrics);
    } catch {
      // Best effort stream fan-out.
    }
  }
}

export function ingestPerformanceMetrics(port: number, incoming: unknown[]): IngestPerformanceResult {
  const grouped = createEmptyBundle();

  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(incoming) || incoming.length === 0) {
    return {
      accepted: 0,
      rejected: Array.isArray(incoming) ? incoming.length : 0,
      metrics: grouped
    };
  }

  const store = ensurePortStore(port);
  let accepted = 0;
  let rejected = 0;
  for (const rawMetric of incoming) {
    const normalized = normalizeMetric(rawMetric as Partial<PerformanceMetricEntry>);
    if (!normalized) {
      rejected += 1;
      continue;
    }
    appendMetric(store, normalized);
    appendMetric(grouped, normalized);
    accepted += 1;
  }

  if (accepted > 0) {
    notifySubscribers(port, grouped);
  }

  return {
    accepted,
    rejected,
    metrics: grouped
  };
}

export function getPerformanceMetrics(port: number): PerformanceMetricsBundle {
  const store = storesByPort.get(port);
  if (!store) return createEmptyBundle();
  return cloneBundle(store);
}

export function clearPerformanceMetrics(port: number): boolean {
  return storesByPort.delete(port);
}

export function subscribePerformanceMetrics(port: number, handler: Subscriber): () => void {
  let subscribers = subscribersByPort.get(port);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByPort.set(port, subscribers);
  }
  subscribers.add(handler);
  return () => {
    const current = subscribersByPort.get(port);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      subscribersByPort.delete(port);
    }
  };
}

function cleanupStaleStores(): void {
  const now = Date.now();
  for (const [port, store] of storesByPort.entries()) {
    if (now - store.lastActivity > STALE_PORT_TIMEOUT_MS) {
      storesByPort.delete(port);
      subscribersByPort.delete(port);
    }
  }
}

export function startPerformanceStoreCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleStores, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

export function stopPerformanceStoreCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

startPerformanceStoreCleanup();
