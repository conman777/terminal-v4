import { describe, expect, it } from 'vitest';
import { applyOptimistic, validateSnapshot } from './followupQueueSnapshot';

const A = '00000000-0000-4000-8000-000000000010';
const B = '00000000-0000-4000-8000-000000000011';
const C = '00000000-0000-4000-8000-000000000012';
const item = (itemId, text, n) => ({ itemId, revision: 1, text, inputRequestId: `00000000-0000-4000-8000-0000000000${n}`, state: 'pending' });
const snapshot = { revision: 2, mode: 'running', holdReason: null, items: [item(A, 'a', 20), item(B, 'b', 21)], order: [A, B] };

describe('applyOptimistic', () => {
  it.each([
    ['enqueue', { kind: 'enqueue', itemId: C, text: 'c' }, [A, B, C], ['a', 'b', 'c'], [C]],
    ['edit', { kind: 'edit', itemId: A, text: 'a2' }, [A, B], ['a2', 'b'], [A]],
    ['remove', { kind: 'remove', itemId: A }, [B], ['a', 'b'], [A]],
    ['promote', { kind: 'promote', itemId: B }, [B, A], ['a', 'b'], [B]],
    ['reorder', { kind: 'reorder', itemIds: [B, A] }, [B, A], ['a', 'b'], [B, A]],
  ])('projects %s without touching the host snapshot', (_name, operation, order, texts, saving) => {
    const before = JSON.stringify(snapshot);
    const view = applyOptimistic(snapshot, operation);
    expect({ order: view.order, texts: view.items.map(entry => entry.text), saving: [...view.saving] }).toEqual({ order, texts, saving });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('leaves the queue unchanged for pause, resume and wake', () => {
    const view = applyOptimistic(snapshot, { kind: 'pause' });
    expect({ order: view.order, saving: view.saving.size }).toEqual({ order: [A, B], saving: 0 });
  });

  it('does not duplicate an enqueue the refreshed snapshot already holds', () => {
    const committed = { ...snapshot, revision: 3, items: [...snapshot.items, item(C, 'c', 22)], order: [A, B, C] };
    const view = applyOptimistic(committed, { kind: 'enqueue', itemId: C, text: 'c' });
    expect({ ids: view.items.map(entry => entry.itemId), order: view.order, saving: [...view.saving] })
      .toEqual({ ids: [A, B, C], order: [A, B, C], saving: [] });
  });
});

describe('validateSnapshot', () => {
  it('rejects an order that names a non-pending item', () => {
    expect(() => validateSnapshot({ ...snapshot, order: [A, C] })).toThrow(/invalid queue order/);
  });
  it('accepts a consistent snapshot', () => {
    expect(validateSnapshot(snapshot)).toBe(snapshot);
  });
});
