import { describe, expect, it } from 'vitest';
import { attachTurnChanges, formatWorkDuration, groupTurnWork, parsePlan } from './conversationWork';

const user = (ts, content = 'Do it') => ({ role: 'user', content, ts });
const reply = (ts, content) => ({ role: 'assistant', content, ts });
const activity = ts => ({ role: 'activity', messages: [{ role: 'tool', toolName: 'read', ts }] });

describe('groupTurnWork', () => {
  it('folds a finished turn\'s tool work and interim replies into one work group before the final reply', () => {
    const timeline = [user(1000), activity(2000), reply(3000, 'Looking'), activity(4000), reply(151000, 'Done'), user(160000, 'Thanks'), reply(161000, 'Welcome')];
    expect(groupTurnWork(timeline).map(item => item.role === 'work' ? ['work', item.durationMs, item.items.length] : [item.role, item.content])).toEqual([
      ['user', 'Do it'], ['work', 150000, 3], ['assistant', 'Done'], ['user', 'Thanks'], ['assistant', 'Welcome'],
    ]);
  });

  it('leaves the turn that is still running expanded so progress stays visible', () => {
    const timeline = [user(1000), activity(2000), reply(3000, 'Still going')];
    expect(groupTurnWork(timeline, { inProgress: true })).toEqual(timeline);
  });

  it('folds thinking and the plan into the finished turn even when no tools ran', () => {
    const thinking = { role: 'reasoning', content: 'Checking', ts: 1500 };
    const plan = { role: 'plan', content: '{}', ts: 1600 };
    const grouped = groupTurnWork([user(1000), thinking, plan, reply(4000, 'Done')]);
    expect(grouped).toEqual([user(1000), { role: 'work', items: [thinking, plan], durationMs: 3000 }, reply(4000, 'Done')]);
  });

  it('keeps errors visible outside the folded work', () => {
    const error = { role: 'error', content: 'Tool failed', ts: 2500 };
    const grouped = groupTurnWork([user(1000), activity(2000), error, reply(3000, 'Recovered')]);
    expect(grouped.map(item => item.role)).toEqual(['user', 'work', 'error', 'assistant']);
  });
});

describe('formatWorkDuration', () => {
  it('reads like T3 Code\'s "Worked for" label', () => {
    expect([450, 12000, 150000, 3720000, null].map(formatWorkDuration)).toEqual(['Worked for <1s', 'Worked for 12s', 'Worked for 2m 30s', 'Worked for 62m', 'Worked']);
  });
});

describe('attachTurnChanges', () => {
  const changes = { files: [{ path: 'a.js', added: 2, removed: 1 }], added: 2, removed: 1, from: 'a', to: 'b' };

  it('places each finished turn\'s changes after its final reply', () => {
    const items = [{ ...user(1), turnId: 't1' }, reply(2, 'Done'), { ...user(3), turnId: 't2' }, reply(4, 'Nothing to change')];
    expect(attachTurnChanges(items, { t1: changes }).map(item => item.role === 'turn-changes' ? [item.role, item.turnId, item.changes] : [item.role, item.content])).toEqual([
      ['user', 'Do it'], ['assistant', 'Done'], ['turn-changes', 't1', changes], ['user', 'Do it'], ['assistant', 'Nothing to change'],
    ]);
  });

  it('adds the last turn\'s changes at the end and returns the same list when there are none', () => {
    const items = [{ ...user(1), turnId: 't1' }, reply(2, 'Done')];
    expect([attachTurnChanges(items, { t1: changes }).at(-1).role, attachTurnChanges(items, {})]).toEqual(['turn-changes', items]);
  });

  it('keys Claude turns, which have no turn id, by the user message id', () => {
    const items = [{ ...user(1), messageId: 'm1' }, reply(2, 'Done')];
    expect(attachTurnChanges(items, { m1: changes }).at(-1)).toEqual({ role: 'turn-changes', turnId: 'm1', changes });
  });
});

describe('parsePlan', () => {
  it('keeps named steps and drops unusable plans', () => {
    const steps = [{ step: 'Fix CSS', status: 'completed' }, { step: ' ', status: 'pending' }, { status: 'pending' }];
    expect([
      parsePlan(JSON.stringify({ explanation: 'Why', steps })),
      parsePlan(JSON.stringify({ steps: [] })),
      parsePlan('not json'),
    ]).toEqual([{ explanation: 'Why', steps: [{ step: 'Fix CSS', status: 'completed' }] }, null, null]);
  });
});
