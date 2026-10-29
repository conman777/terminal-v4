import { describe, expect, it } from 'vitest';
import { applyProjectOrder, moveRelative, stepTarget } from './threadOrder';

const s = (id, path = '/p', pinned = false) => ({ id, thread: { projectPath: path, pinned } });
const pathOf = session => session.thread.projectPath;
const ids = list => list.map(item => item.id);

describe('applyProjectOrder', () => {
  it('returns the input untouched when a project has no saved order', () => {
    expect(ids(applyProjectOrder([s('a'), s('b')], {}, pathOf))).toEqual(['a', 'b']);
  });

  it('reorders one project inside the slots it already occupies', () => {
    const list = [s('a1', '/a'), s('b1', '/b'), s('a2', '/a'), s('b2', '/b'), s('a3', '/a')];
    expect(ids(applyProjectOrder(list, { '/a': ['a3', 'a1', 'a2'] }, pathOf))).toEqual(['a3', 'b1', 'a1', 'b2', 'a2']);
  });

  it('puts threads missing from the saved order first, in their original order', () => {
    const list = [s('new1'), s('b'), s('new2'), s('a')];
    expect(ids(applyProjectOrder(list, { '/p': ['a', 'b'] }, pathOf))).toEqual(['new1', 'new2', 'a', 'b']);
  });

  it('ignores saved ids that no longer exist', () => {
    expect(ids(applyProjectOrder([s('a'), s('b')], { '/p': ['gone', 'b', 'a'] }, pathOf))).toEqual(['b', 'a']);
  });

  it('keeps pinned threads ahead of unpinned ones whatever the saved order says', () => {
    const list = [s('p1', '/p', true), s('x'), s('p2', '/p', true), s('y')];
    expect(ids(applyProjectOrder(list, { '/p': ['y', 'x', 'p2', 'p1'] }, pathOf, { pinnedFirst: true }))).toEqual(['p2', 'p1', 'y', 'x']);
  });
});

describe('moveRelative', () => {
  it('moves an id before a target', () => {
    expect(moveRelative(['a', 'b', 'c', 'd'], 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves an id after a target', () => {
    expect(moveRelative(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns null when nothing would change or an id is unknown', () => {
    expect(moveRelative(['a', 'b'], 'a', 'a', true)).toBeNull();
    expect(moveRelative(['a', 'b'], 'a', 'b', false)).toBeNull();
    expect(moveRelative(['a', 'b'], 'a', 'zzz', true)).toBeNull();
  });
});

describe('stepTarget', () => {
  it('finds the visible neighbour above or below', () => {
    expect(stepTarget(['a', 'b', 'c'], 'b', -1)).toEqual({ targetId: 'a', after: false });
    expect(stepTarget(['a', 'b', 'c'], 'b', 1)).toEqual({ targetId: 'c', after: true });
  });

  it('returns null at the ends or for an unknown id', () => {
    expect(stepTarget(['a', 'b'], 'a', -1)).toBeNull();
    expect(stepTarget(['a', 'b'], 'b', 1)).toBeNull();
    expect(stepTarget(['a', 'b'], 'q', 1)).toBeNull();
  });
});
