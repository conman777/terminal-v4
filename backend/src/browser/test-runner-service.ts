/**
 * Test Runner Service
 *
 * Executes tests in parallel using the worker pool.
 * Supports retries, screenshots on failure, and real-time progress streaming.
 */

import vm from 'vm';
import type { TestJob, TestRun, CodeFramework } from './automation-types.js';
import { acquireWorker, releaseWorker, isPoolReady, initializePool } from './worker-pool.js';
import type { Worker } from './worker-pool.js';

// Active test runs
const testRuns = new Map<string, TestRun>();

// WebSocket connections for streaming (to be set by route handler)
const streamConnections = new Map<string, any>();

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Register a WebSocket connection for streaming test updates
 */
export function registerStreamConnection(runId: string, ws: any): void {
  streamConnections.set(runId, ws);
}

/**
 * Unregister a WebSocket connection
 */
export function unregisterStreamConnection(runId: string): void {
  streamConnections.delete(runId);
}

/**
 * Send update to WebSocket client
 */
function sendUpdate(runId: string, update: any): void {
  const ws = streamConnections.get(runId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(update));
    } catch (err) {
      console.error(`[test-runner] Error sending update for run ${runId}:`, err);
    }
  }
}

/**
 * Run tests in parallel
 */
export async function runTests(tests: Array<{
  name: string;
  code: string;
  framework: CodeFramework;
}>, options: {
  maxRetries?: number;
  captureScreenshotOnFailure?: boolean;
  concurrency?: number;
} = {}): Promise<TestRun> {
  // Ensure pool is initialized with requested concurrency
  const concurrency = options.concurrency ?? 3;
  if (!isPoolReady()) {
    await initializePool(concurrency);
  }

  const runId = generateId();
  const maxRetries = options.maxRetries ?? 1;
  const captureScreenshotOnFailure = options.captureScreenshotOnFailure ?? true;

  // Create test jobs
  const jobs: TestJob[] = tests.map(test => ({
    id: generateId(),
    runId,
    name: test.name,
    code: test.code,
    framework: test.framework,
    status: 'queued',
    logs: []
  }));

  const run: TestRun = {
    id: runId,
    jobs,
    startTime: Date.now(),
    status: 'running',
    summary: {
      total: jobs.length,
      passed: 0,
      failed: 0,
      error: 0
    }
  };

  testRuns.set(runId, run);

  // Send initial update
  sendUpdate(runId, { type: 'run-started', run });

  console.log(`[test-runner] Starting test run ${runId} with ${jobs.length} tests`);

  // Execute jobs in parallel
  const jobPromises = jobs.map(job => executeJob(job, maxRetries, captureScreenshotOnFailure));

  // Wait for all jobs to complete
  await Promise.allSettled(jobPromises);

  // Update run status
  run.status = 'completed';
  run.endTime = Date.now();

  // Calculate summary
  run.summary = {
    total: jobs.length,
    passed: jobs.filter(j => j.status === 'passed').length,
    failed: jobs.filter(j => j.status === 'failed').length,
    error: jobs.filter(j => j.status === 'error').length
  };

  // Send final update
  sendUpdate(runId, { type: 'run-completed', run });

  console.log(`[test-runner] Test run ${runId} completed:`, run.summary);

  return run;
}

/**
 * Execute a single test job
 */
async function executeJob(
  job: TestJob,
  maxRetries: number,
  captureScreenshotOnFailure: boolean
): Promise<void> {
  let attempt = 0;
  let lastError: string | undefined;

  while (attempt <= maxRetries) {
    attempt++;

    try {
      console.log(`[test-runner] Executing job ${job.id} (attempt ${attempt}/${maxRetries + 1})`);

      job.status = 'running';
      job.startTime = Date.now();

      sendUpdate(job.runId, { type: 'job-started', job });

      // Acquire worker (will throw if timeout or queue full)
      const worker = await acquireWorker(job.id);

      try {
        // Execute test
        await executeTestCode(worker, job);

        // Success
        job.status = 'passed';
        job.endTime = Date.now();
        job.duration = job.endTime - (job.startTime || 0);

        console.log(`[test-runner] Job ${job.id} passed in ${job.duration}ms`);

        sendUpdate(job.runId, { type: 'job-completed', job });

        return; // Success, no retry needed
      } finally {
        // Always release worker
        await releaseWorker(worker.id);
      }
    } catch (err: any) {
      lastError = err.message;
      job.logs.push(`Attempt ${attempt} failed: ${err.message}`);

      console.error(`[test-runner] Job ${job.id} attempt ${attempt} failed:`, err.message);

      // If this was the last attempt, mark as failed
      if (attempt > maxRetries) {
        job.status = 'error';
        job.error = lastError;
        job.endTime = Date.now();
        job.duration = job.endTime - (job.startTime || 0);

        sendUpdate(job.runId, { type: 'job-failed', job });

        console.error(`[test-runner] Job ${job.id} failed after ${attempt} attempts`);
      } else {
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

/**
 * Execute test code in a worker
 */
async function executeTestCode(worker: Worker, job: TestJob): Promise<void> {
  const { page } = worker;

  // Capture console logs
  const logs: string[] = [];
  const consoleHandler = (msg: any) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  };
  page.on('console', consoleHandler);

  // Capture page errors
  const errorHandler = (err: Error) => {
    logs.push(`[error] ${err.message}`);
  };
  page.on('pageerror', errorHandler);

  try {
    // Execute test based on framework
    if (job.framework === 'playwright') {
      await executePlaywrightTest(worker, job.code);
    } else {
      throw new Error(`Unsupported framework: ${job.framework}`);
    }

    // Store logs
    job.logs = logs;
  } catch (err: any) {
    // Store logs
    job.logs = logs;

    // Capture screenshot on failure
    if (job.framework === 'playwright') {
      try {
        job.screenshot = await page.screenshot({ fullPage: false });
      } catch (screenshotErr) {
        console.error(`[test-runner] Failed to capture screenshot:`, screenshotErr);
      }
    }

    throw err;
  } finally {
    // Remove listeners
    page.off('console', consoleHandler);
    page.off('pageerror', errorHandler);
  }
}

/**
 * Execute Playwright test code
 */
async function executePlaywrightTest(worker: Worker, code: string): Promise<void> {
  const { page } = worker;

  // Create restricted sandbox - NO access to require, process, fs, etc.
  const sandbox = {
    // Only provide safe APIs
    page: page,
    expect: createExpect(page),
    console: {
      log: (...args: any[]) => console.log('[test]', ...args),
      error: (...args: any[]) => console.error('[test]', ...args),
      warn: (...args: any[]) => console.warn('[test]', ...args),
      info: (...args: any[]) => console.info('[test]', ...args)
    },
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    Promise,
    Error,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    // NO: require, process, Buffer, global, __dirname, __filename, etc.
  };

  // Wrap code in async IIFE
  const wrappedCode = `
    (async () => {
      ${code}
    })();
  `;

  // Create VM script with timeout
  let script: vm.Script;
  try {
    script = new vm.Script(wrappedCode, {
      filename: 'generated-test.js',
      timeout: 30000 // 30 second compilation timeout
    });
  } catch (err: any) {
    throw new Error(`Test compilation failed: ${err.message}`);
  }

  // Create isolated context
  const context = vm.createContext(sandbox, {
    name: 'test-sandbox',
    codeGeneration: {
      strings: false, // Disable eval()
      wasm: false     // Disable WebAssembly
    }
  });

  // Execute with timeout
  const executionTimeout = 60000; // 60 seconds
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Test execution timeout')), executionTimeout);
  });

  try {
    const executionPromise = script.runInContext(context, {
      breakOnSigint: true,
      timeout: executionTimeout
    });

    await Promise.race([
      executionPromise,
      timeoutPromise
    ]);
  } catch (err: any) {
    if (err.message.includes('timeout')) {
      throw new Error('Test execution exceeded 60 second timeout');
    }
    throw new Error(`Test execution failed: ${err.message}`);
  }
}

/**
 * Create expect helper for assertions
 */
function createExpect(page: any) {
  return {
    toBeVisible: async (locator: any) => {
      const visible = await locator.isVisible();
      if (!visible) {
        throw new Error(`Expected element to be visible`);
      }
    },
    toBeHidden: async (locator: any) => {
      const visible = await locator.isVisible();
      if (visible) {
        throw new Error(`Expected element to be hidden`);
      }
    },
    toHaveText: async (locator: any, expected: string) => {
      const text = await locator.innerText();
      if (text !== expected) {
        throw new Error(`Expected text to be "${expected}", but got "${text}"`);
      }
    },
    toHaveValue: async (locator: any, expected: string) => {
      const value = await locator.inputValue();
      if (value !== expected) {
        throw new Error(`Expected value to be "${expected}", but got "${value}"`);
      }
    },
    toHaveCount: async (locator: any, expected: number) => {
      const count = await locator.count();
      if (count !== expected) {
        throw new Error(`Expected count to be ${expected}, but got ${count}`);
      }
    }
  };
}

/**
 * Get test run
 */
export function getTestRun(runId: string): TestRun | null {
  return testRuns.get(runId) || null;
}

/**
 * Get test job
 */
export function getTestJob(jobId: string): TestJob | null {
  for (const run of testRuns.values()) {
    const job = run.jobs.find(j => j.id === jobId);
    if (job) {
      return job;
    }
  }
  return null;
}

/**
 * Get all test runs
 */
export function getAllTestRuns(): TestRun[] {
  return Array.from(testRuns.values());
}

/**
 * Cancel a test run
 */
export function cancelTestRun(runId: string): boolean {
  const run = testRuns.get(runId);
  if (!run || run.status !== 'running') {
    return false;
  }

  run.status = 'cancelled';
  run.endTime = Date.now();

  // Mark all queued/running jobs as cancelled
  for (const job of run.jobs) {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'error';
      job.error = 'Test run cancelled';
      job.endTime = Date.now();
    }
  }

  sendUpdate(runId, { type: 'run-cancelled', run });

  return true;
}

/**
 * Clear old test runs (keep last N)
 */
export function clearOldTestRuns(keepLast = 10): number {
  const runs = Array.from(testRuns.entries())
    .sort((a, b) => b[1].startTime - a[1].startTime);

  const toDelete = runs.slice(keepLast);
  toDelete.forEach(([id]) => testRuns.delete(id));

  return toDelete.length;
}
