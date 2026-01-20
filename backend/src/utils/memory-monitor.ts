/**
 * Memory Monitor
 *
 * Monitors Node.js process memory usage and warns when approaching limits.
 * Triggers garbage collection when available and memory pressure is high.
 */

const MEMORY_CHECK_INTERVAL = 30000; // 30 seconds
const MEMORY_WARNING_THRESHOLD = 0.8; // 80% of heap limit

let monitorInterval: NodeJS.Timeout | null = null;

/**
 * Start monitoring memory usage
 */
export function startMemoryMonitoring(): void {
  if (monitorInterval) {
    console.log('[memory-monitor] Already running');
    return;
  }

  monitorInterval = setInterval(() => {
    const usage = process.memoryUsage();
    const heapLimit = usage.heapTotal;
    const heapUsed = usage.heapUsed;
    const percentage = heapUsed / heapLimit;

    if (percentage > MEMORY_WARNING_THRESHOLD) {
      console.warn(
        `[memory-monitor] Memory usage high: ${(percentage * 100).toFixed(2)}% ` +
        `(${(heapUsed / 1024 / 1024).toFixed(2)}MB / ${(heapLimit / 1024 / 1024).toFixed(2)}MB)`
      );

      // Trigger garbage collection if available (requires --expose-gc flag)
      if (global.gc) {
        console.log('[memory-monitor] Running manual garbage collection...');
        try {
          global.gc();
          const afterGC = process.memoryUsage();
          console.log(
            `[memory-monitor] GC completed. Freed ${((heapUsed - afterGC.heapUsed) / 1024 / 1024).toFixed(2)}MB`
          );
        } catch (error) {
          console.error('[memory-monitor] Error during garbage collection:', error);
        }
      } else {
        console.warn('[memory-monitor] Manual GC not available. Start node with --expose-gc to enable.');
      }
    }
  }, MEMORY_CHECK_INTERVAL);

  console.log('[memory-monitor] Started');
}

/**
 * Stop monitoring memory usage
 */
export function stopMemoryMonitoring(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[memory-monitor] Stopped');
  }
}

/**
 * Get current memory usage statistics
 */
export function getMemoryStats(): {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  percentage: number;
} {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    percentage: (usage.heapUsed / usage.heapTotal) * 100
  };
}
