import { monitorEventLoopDelay } from 'node:perf_hooks';

interface HistogramSnapshot {
  mean: number;
  max: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

interface HistogramFactory {
  (options: { resolution: number }): HistogramSnapshot;
}

interface TimerApi {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface EventLoopMonitorOptions {
  resolutionMs?: number;
  idleTimeoutMs?: number;
  createHistogram?: HistogramFactory;
  timerApi?: TimerApi;
}

export interface EventLoopSnapshot {
  meanMs: number;
  maxMs: number;
}

function toRoundedMilliseconds(value: number): number {
  const milliseconds = value / 1e6;
  return Number.isFinite(milliseconds) ? Math.round(milliseconds) : 0;
}

export function createAutoIdleEventLoopMonitor({
  resolutionMs = 100,
  idleTimeoutMs = 20_000,
  createHistogram = monitorEventLoopDelay as HistogramFactory,
  timerApi = { setTimeout, clearTimeout }
}: EventLoopMonitorOptions = {}) {
  let histogram: HistogramSnapshot | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    timerApi.clearTimeout(idleTimer);
    idleTimer = null;
  };

  const disable = () => {
    clearIdleTimer();
    if (!histogram) return;
    histogram.disable();
    histogram = null;
  };

  const ensureEnabled = () => {
    if (!histogram) {
      histogram = createHistogram({ resolution: resolutionMs });
      histogram.enable();
    }
    clearIdleTimer();
    idleTimer = timerApi.setTimeout(disable, idleTimeoutMs);
    idleTimer.unref?.();
    return histogram;
  };

  return {
    read(): EventLoopSnapshot {
      const activeHistogram = ensureEnabled();
      const snapshot = {
        meanMs: toRoundedMilliseconds(activeHistogram.mean),
        maxMs: toRoundedMilliseconds(activeHistogram.max)
      };
      activeHistogram.reset();
      return snapshot;
    },
    stop(): void {
      disable();
    }
  };
}
