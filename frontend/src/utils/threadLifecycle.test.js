import { describe, expect, it } from 'vitest';
import * as lifecycle from './threadLifecycle';

describe('settled threads', () => {
  const settled = {
    id: 'ss-example', runtime: 'v4', status: 'completed', isBusy: false,
    thread: { archived: false },
    threadLifecycle: { settlementSupported: true, settled: true, requiresAttention: false },
  };

  it('classifies only server-confirmed idle V4 threads as settled', () => {
    expect(typeof lifecycle.isSettledThread).toBe('function');
    expect([
      lifecycle.isSettledThread(settled),
      lifecycle.isSettledThread({ ...settled, status: 'running' }),
      lifecycle.isSettledThread({ ...settled, status: undefined }),
      lifecycle.isSettledThread({ ...settled, runtime: 'codex' }),
      lifecycle.isSettledThread({ ...settled, thread: { archived: true } }),
      lifecycle.isSettledThread({ ...settled, threadLifecycle: { ...settled.threadLifecycle, requiresAttention: true } }),
      lifecycle.isSettledThread({ ...settled, threadLifecycle: { ...settled.threadLifecycle, settlementSupported: false } }),
      lifecycle.isSettledThread(settled, { isBusy: true }),
    ]).toEqual([true, false, false, false, false, false, false, false]);
  });
});
