import { beforeEach, describe, expect, it } from 'vitest';
import { dismissLearningNudge, shouldNudgeLearning } from './learningNudge';

beforeEach(() => localStorage.clear());

describe('learning nudge', () => {
  it('suggests saving knowledge after a longer conversation, and again much later once dismissed', () => {
    const early = shouldNudgeLearning('ss-1', 3);
    const due = shouldNudgeLearning('ss-1', 4);
    dismissLearningNudge('ss-1', 4);
    expect([early, due, shouldNudgeLearning('ss-1', 9), shouldNudgeLearning('ss-1', 10), shouldNudgeLearning('ss-2', 4)]).toEqual([false, true, false, true, true]);
  });
});
