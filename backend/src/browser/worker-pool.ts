/**
 * Worker Pool Service
 *
 * Manages a pool of browser workers for parallel test execution.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { cpus } from 'os';

// Resource limits
const MAX_WORKER_MEMORY_MB = 512;
const MAX_WORKER_CPU_PERCENT = 50;
const RESOURCE_CHECK_INTERVAL_MS = 10000; // 10 seconds

export interface Worker {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  busy: boolean;
  currentJobId?: string;
  memoryUsageMB?: number;
  lastResourceCheck?: number;
}

export interface WorkerPool {
  workers: Worker[];
  maxWorkers: number;
  initialized: boolean;
  resourceMonitorInterval?: NodeJS.Timeout;
}

// Global worker pool
let pool: WorkerPool | null = null;

// Queue for waiting requests
interface QueuedRequest {
  jobId: string;
  resolve: (worker: Worker) => void;
  reject: (err: Error) => void;
  timestamp: number;
  timeoutId: NodeJS.Timeout;
}

const workerQueue: QueuedRequest[] = [];
const MAX_QUEUE_SIZE = 100;

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Cleanup stale queue entries periodically
const staleQueueCleanup = setInterval(() => {
  const now = Date.now();
  const STALE_THRESHOLD = 60000; // 1 minute

  for (let i = workerQueue.length - 1; i >= 0; i--) {
    const request = workerQueue[i];
    if (now - request.timestamp > STALE_THRESHOLD) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Request removed due to staleness'));
      workerQueue.splice(i, 1);
    }
  }
}, 30000); // Check every 30 seconds

/**
 * Initialize the worker pool
 */
export async function initializePool(maxWorkers?: number): Promise<WorkerPool> {
  // Clean up existing pool if any
  if (pool) {
    await shutdownPool();
  }

  // Default to CPU count or max 4
  const workerCount = maxWorkers || Math.min(cpus().length, 4);

  pool = {
    workers: [],
    maxWorkers: workerCount,
    initialized: false
  };

  console.log(`[worker-pool] Initializing pool with ${workerCount} workers`);

  // Create workers
  for (let i = 0; i < workerCount; i++) {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const context = await browser.newContext();
      const page = await context.newPage();

      const worker: Worker = {
        id: `worker-${i}`,
        browser,
        context,
        page,
        busy: false
      };

      pool.workers.push(worker);
      console.log(`[worker-pool] Worker ${worker.id} initialized`);
    } catch (err) {
      console.error(`[worker-pool] Failed to initialize worker ${i}:`, err);
    }
  }

  pool.initialized = true;
  console.log(`[worker-pool] Pool initialized with ${pool.workers.length} workers`);

  // Start resource monitoring
  startResourceMonitoring();

  return pool;
}

/**
 * Get the worker pool
 */
export function getPool(): WorkerPool | null {
  return pool;
}

/**
 * Get an available worker (event-based queue)
 */
export async function acquireWorker(
  jobId: string,
  timeout: number = 30000
): Promise<Worker> {
  if (!pool || !pool.initialized) {
    throw new Error('Worker pool not initialized');
  }

  // Check queue size for backpressure
  if (workerQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error(`Worker queue full (${MAX_QUEUE_SIZE} requests). Try again later.`);
  }

  // Try to get worker immediately
  const availableWorker = pool.workers.find(w => !w.busy);
  if (availableWorker) {
    availableWorker.busy = true;
    availableWorker.currentJobId = jobId;
    console.log(`[worker-pool] Worker ${availableWorker.id} acquired for job ${jobId}`);
    return availableWorker;
  }

  // Queue the request with timeout
  return new Promise<Worker>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      // Remove from queue
      const index = workerQueue.findIndex(q => q.jobId === jobId);
      if (index !== -1) {
        workerQueue.splice(index, 1);
      }
      reject(new Error(`Timeout acquiring worker for job ${jobId} after ${timeout}ms`));
    }, timeout);

    workerQueue.push({
      jobId,
      resolve,
      reject,
      timestamp: Date.now(),
      timeoutId
    });

    console.log(`[worker-pool] Job ${jobId} queued (position ${workerQueue.length})`);
  });
}

/**
 * Release a worker back to the pool
 */
export async function releaseWorker(workerId: string): Promise<void> {
  if (!pool) {
    return;
  }

  const worker = pool.workers.find(w => w.id === workerId);
  if (!worker) {
    console.warn(`[worker-pool] Worker ${workerId} not found`);
    return;
  }

  // Clean up the page
  try {
    // Navigate to blank page first
    await worker.page.goto('about:blank');

    // Clear cookies
    await worker.context.clearCookies();

    // Try to clear storage (may fail on about:blank, which is OK)
    try {
      await worker.page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (e) {
          // Storage not available on about:blank, ignore
        }
      });
    } catch (err) {
      // Ignore storage errors on about:blank
    }
  } catch (err) {
    console.error(`[worker-pool] Error cleaning worker ${workerId}:`, err);
    // If cleanup fails, recreate the worker
    await recreateWorker(workerId);
    return;
  }

  // Process queue (FIFO)
  const nextJob = workerQueue.shift();
  if (nextJob) {
    // Clear timeout
    clearTimeout(nextJob.timeoutId);

    // Assign worker to queued job
    worker.busy = true;
    worker.currentJobId = nextJob.jobId;
    console.log(`[worker-pool] Worker ${worker.id} assigned to queued job ${nextJob.jobId}`);
    nextJob.resolve(worker);
  } else {
    // No queued jobs, mark as available
    worker.busy = false;
    worker.currentJobId = undefined;
    console.log(`[worker-pool] Worker ${worker.id} released`);
  }
}

/**
 * Recreate a worker (if it crashes or becomes unusable)
 */
async function recreateWorker(workerId: string): Promise<void> {
  if (!pool) {
    return;
  }

  const index = pool.workers.findIndex(w => w.id === workerId);
  if (index === -1) {
    return;
  }

  const oldWorker = pool.workers[index];

  console.log(`[worker-pool] Recreating worker ${workerId}`);

  try {
    // Close old browser
    await oldWorker.browser.close();
  } catch (err) {
    // Ignore errors when closing
  }

  try {
    // Create new worker
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const newWorker: Worker = {
      id: workerId,
      browser,
      context,
      page,
      busy: false
    };

    pool.workers[index] = newWorker;
    console.log(`[worker-pool] Worker ${workerId} recreated`);
  } catch (err) {
    console.error(`[worker-pool] Failed to recreate worker ${workerId}:`, err);
    // Remove the worker from the pool
    pool.workers.splice(index, 1);
  }
}

/**
 * Start resource monitoring
 */
function startResourceMonitoring(): void {
  if (!pool) {
    return;
  }

  // Clear any existing interval
  if (pool.resourceMonitorInterval) {
    clearInterval(pool.resourceMonitorInterval);
  }

  pool.resourceMonitorInterval = setInterval(() => {
    if (!pool) {
      return;
    }

    pool.workers.forEach(worker => {
      monitorWorkerResources(worker.id).catch(err => {
        console.error(`[worker-pool] Error monitoring worker ${worker.id}:`, err);
      });
    });
  }, RESOURCE_CHECK_INTERVAL_MS);
}

/**
 * Monitor worker resource usage
 */
async function monitorWorkerResources(workerId: string): Promise<void> {
  if (!pool) {
    return;
  }

  const worker = pool.workers.find(w => w.id === workerId);
  if (!worker) {
    return;
  }

  try {
    // Get Node.js process memory usage
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;

    // Update worker stats
    worker.memoryUsageMB = heapUsedMB;
    worker.lastResourceCheck = Date.now();

    // Check if worker exceeded memory limit
    if (heapUsedMB > MAX_WORKER_MEMORY_MB) {
      console.warn(
        `[worker-pool] Worker ${workerId} exceeded memory limit ` +
        `(${heapUsedMB.toFixed(2)}MB > ${MAX_WORKER_MEMORY_MB}MB), restarting`
      );

      // If worker is busy, this could interrupt a test
      // In production, we'd want to wait for test completion
      if (!worker.busy) {
        await recreateWorker(workerId);
      } else {
        console.warn(`[worker-pool] Worker ${workerId} is busy, will restart after job completes`);
      }
    }
  } catch (err) {
    console.error(`[worker-pool] Error checking resources for worker ${workerId}:`, err);
  }
}

/**
 * Stop resource monitoring
 */
function stopResourceMonitoring(): void {
  if (pool?.resourceMonitorInterval) {
    clearInterval(pool.resourceMonitorInterval);
    pool.resourceMonitorInterval = undefined;
  }
}

/**
 * Shutdown the worker pool
 */
export async function shutdownPool(): Promise<void> {
  if (!pool) {
    return;
  }

  console.log(`[worker-pool] Shutting down pool with ${pool.workers.length} workers`);

  // Stop resource monitoring
  stopResourceMonitoring();

  // Reject all queued requests
  while (workerQueue.length > 0) {
    const request = workerQueue.shift();
    if (request) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Worker pool shutting down'));
    }
  }

  for (const worker of pool.workers) {
    try {
      await worker.browser.close();
      console.log(`[worker-pool] Worker ${worker.id} closed`);
    } catch (err) {
      console.error(`[worker-pool] Error closing worker ${worker.id}:`, err);
    }
  }

  pool = null;
  console.log(`[worker-pool] Pool shutdown complete`);
}

/**
 * Get pool statistics
 */
export function getPoolStats(): {
  initialized: boolean;
  totalWorkers: number;
  busyWorkers: number;
  availableWorkers: number;
  queuedRequests: number;
  maxQueueSize: number;
  queueUtilization: string;
  workers: Array<{
    id: string;
    busy: boolean;
    currentJobId?: string;
    memoryUsageMB?: number;
    lastResourceCheck?: number;
  }>;
} {
  if (!pool) {
    return {
      initialized: false,
      totalWorkers: 0,
      busyWorkers: 0,
      availableWorkers: 0,
      queuedRequests: 0,
      maxQueueSize: MAX_QUEUE_SIZE,
      queueUtilization: '0.00%',
      workers: []
    };
  }

  const busyWorkers = pool.workers.filter(w => w.busy).length;

  return {
    initialized: pool.initialized,
    totalWorkers: pool.workers.length,
    busyWorkers,
    availableWorkers: pool.workers.length - busyWorkers,
    queuedRequests: workerQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    queueUtilization: (workerQueue.length / MAX_QUEUE_SIZE * 100).toFixed(2) + '%',
    workers: pool.workers.map(w => ({
      id: w.id,
      busy: w.busy,
      currentJobId: w.currentJobId,
      memoryUsageMB: w.memoryUsageMB,
      lastResourceCheck: w.lastResourceCheck
    }))
  };
}

/**
 * Check if pool is ready
 */
export function isPoolReady(): boolean {
  return pool !== null && pool.initialized && pool.workers.length > 0;
}
