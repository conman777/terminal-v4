import { describe, expect, it } from 'vitest';
import { contextMeter, latestContextUsage } from './contextUsage';

describe('context usage', () => {
  it('reads the latest report and describes how full the context window is', () => {
    const entries = [
      { type: 'context_usage', usage: { contextTokens: 1000, contextWindow: 200000 } },
      { type: 'turn_completed' },
      { type: 'context_usage', usage: { contextTokens: 50000, contextWindow: 200000, costUsd: 0.0421, inputTokens: 48000, outputTokens: 2000 } },
    ];
    const usage = latestContextUsage({ entries });
    expect([contextMeter(usage), contextMeter({ contextTokens: 10 }), latestContextUsage({ entries: [] })]).toEqual([
      { percent: 25, label: 'Context 25%', detail: '50,000 of 200,000 tokens · 48,000 in, 2,000 out · $0.04' }, null, null,
    ]);
  });

  it('does not invent token counters or accept invalid measurements', () => {
    expect(contextMeter({ contextTokens: 10, contextWindow: 100, inputTokens: 8 })).toEqual({
      percent: 10, label: 'Context 10%', detail: '10 of 100 tokens · 8 in',
    });
    for (const usage of [
      { contextTokens: -1, contextWindow: 100 },
      { contextTokens: 1, contextWindow: -100 },
      { contextTokens: 1, contextWindow: Infinity },
      { contextTokens: 1.5, contextWindow: 100 },
    ]) expect(contextMeter(usage)).toBeNull();
  });
});
