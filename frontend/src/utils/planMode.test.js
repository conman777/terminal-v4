import { describe, expect, it } from 'vitest';
import { attachPlanActions, isPlanMessage, PLAN_MARKER, stripPlanMarker } from './planMode';

const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const reply = content => ({ role: 'assistant', content });

describe('plan messages', () => {
  it('recognises and strips the plan marker', () => {
    expect([isPlanMessage(`${PLAN_MARKER}Add search`), isPlanMessage('Add search'), stripPlanMarker(`${PLAN_MARKER}Add search`), stripPlanMarker('Add search')])
      .toEqual([true, false, 'Add search', 'Add search']);
  });
});

describe('attachPlanActions', () => {
  it('offers to implement each finished plan, after its final reply', () => {
    const items = [user(`${PLAN_MARKER}Add search`), reply('Looking'), reply('1. Index\n2. UI'), user('Thanks'), reply('Welcome')];
    expect(attachPlanActions(items).map(item => item.role === 'plan-actions' ? [item.role, item.plan] : item.role)).toEqual([
      'user', 'assistant', 'assistant', ['plan-actions', '1. Index\n2. UI'], 'user', 'assistant',
    ]);
  });

  it('waits until a running plan turn finishes', () => {
    const items = [user(`${PLAN_MARKER}Add search`), reply('1. Index')];
    expect([attachPlanActions(items, { inProgress: true }), attachPlanActions(items).at(-1).role]).toEqual([items, 'plan-actions']);
  });
});
