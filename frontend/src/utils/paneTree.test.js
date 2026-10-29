import { describe, expect, it } from 'vitest';
import { getPaneTreeGeometry, getSplitSizes, paneTreeFromLegacy, resizePaneTree } from './paneTree';

const panes = Array.from({ length: 4 }, (_, index) => ({ type: 'pane', id: `pane-${index + 1}`, sessionId: `session-${index + 1}` }));

describe('getSplitSizes', () => {
  it.each([undefined, [0, 1], [NaN, 1], [Infinity, 1], [1], ['2', 1], [Number.MAX_VALUE, Number.MAX_VALUE]].map(sizes => ({ sizes })))('falls back to equal shares for invalid saved sizes $sizes', ({ sizes }) => {
    expect(getSplitSizes({ children: panes.slice(0, 2), sizes })).toEqual([0.5, 0.5]);
  });
  it('normalizes positive weights without mutating saved proportions', () => {
    const sizes = [3, 1];
    expect(getSplitSizes({ children: panes.slice(0, 2), sizes })).toEqual([0.75, 0.25]);
    expect(sizes).toEqual([3, 1]);
  });
});

describe('resizePaneTree', () => {
  const nested = { type: 'split', direction: 'vertical', children: panes.slice(1, 3) };
  const root = { type: 'split', direction: 'horizontal', children: [panes[0], nested, panes[3]] };
  it('updates only the addressed split and retains pane references and sibling proportions', () => {
    const resized = resizePaneTree(root, [1], [65, 35], ['pane-2', 'pane-3']);
    expect(resized).toEqual({ ...root, children: [panes[0], { ...nested, sizes: [0.65, 0.35] }, panes[3]] });
    expect(resized.children[0]).toBe(panes[0]);
    expect(resized.children[1].children).toBe(nested.children);
    expect(resized.children[2]).toBe(panes[3]);
    expect(root.children[1]).toBe(nested);
  });
  it.each([
    [[8], [0.7, 0.3], ['pane-2', 'pane-3']],
    [[1], [0.7, 0.3], ['pane-3', 'pane-2']],
    [[1], [0.7], ['pane-2', 'pane-3']],
    [[1], [0, 1], ['pane-2', 'pane-3']],
    [[1], [Infinity, 1], ['pane-2', 'pane-3']],
    [[1], [0.5, 0.5], ['pane-2', 'pane-3']],
  ])('ignores stale, invalid and unchanged resize requests %j', (path, sizes, expectedPaneIds) => {
    expect(resizePaneTree(root, path, sizes, expectedPaneIds)).toBe(root);
  });
});

describe('getPaneTreeGeometry', () => {
  it('uses saved proportions, reserves divider space, and reports adjacent-pair bounds', () => {
    const root = { type: 'split', direction: 'horizontal', sizes: [0.25, 0.5, 0.25], children: panes.slice(0, 3) };
    const { leaves, dividers } = getPaneTreeGeometry(root, 1012, 600);
    expect(leaves.map(({ pane, rect }) => ({ id: pane.id, ...rect }))).toEqual([
      { id: 'pane-1', left: 0, top: 0, width: 250, height: 600 },
      { id: 'pane-2', left: 256, top: 0, width: 500, height: 600 },
      { id: 'pane-3', left: 762, top: 0, width: 250, height: 600 },
    ]);
    expect(dividers.map(({ path, index, pairSize, value, min, max }) => ({ path, index, pairSize, value, min, max }))).toEqual([
      { path: [], index: 0, pairSize: 750, value: expect.closeTo(100 / 3), min: 160 / 750 * 100, max: 100 - 160 / 750 * 100 },
      { path: [], index: 1, pairSize: 750, value: expect.closeTo(200 / 3), min: 160 / 750 * 100, max: 100 - 160 / 750 * 100 },
    ]);
  });
  it('enforces nested subtree minimums and softens them only when the viewport is too small', () => {
    const root = { type: 'split', direction: 'horizontal', sizes: [0.01, 0.99], children: [
      { type: 'split', direction: 'horizontal', children: panes.slice(0, 2) }, panes[2],
    ] };
    expect(getPaneTreeGeometry(root, 1000, 600).leaves.map(({ rect }) => rect.width)).toEqual([160, 160, 668]);
    const small = getPaneTreeGeometry(root, 250, 600);
    expect(small.leaves.map(({ rect }) => rect.width).reduce((sum, width) => sum + width, 0)).toBeCloseTo(238);
    expect(small.leaves.every(({ rect }) => rect.width > 0 && rect.left + rect.width <= 250)).toBe(true);
  });
  it('creates horizontal ARIA dividers for stacked panes and preserves fullscreen geometry externally', () => {
    const { leaves, dividers } = getPaneTreeGeometry({ type: 'split', direction: 'vertical', sizes: [0.6, 0.4], children: panes.slice(0, 2) }, 800, 606);
    expect(leaves.map(({ rect }) => rect)).toEqual([
      { left: 0, top: 0, width: 800, height: 360 },
      { left: 0, top: 366, width: 800, height: 240 },
    ]);
    expect(dividers[0]).toMatchObject({ direction: 'vertical', value: 60, min: 20, max: 80, pairSize: 600 });
  });

  it.each([{ width: 320, height: 240 }, { width: 768, height: 600 }, { width: 1440, height: 900 }])('keeps all eight nested pane rectangles finite and inside a $width × $height viewport', ({ width, height }) => {
    const eightPanes = Array.from({ length: 8 }, (_, index) => ({ type: 'pane', id: `pane-${index + 1}` }));
    const root = { type: 'split', direction: 'horizontal', sizes: [0.001, 0.3, 0.699], children: [
      eightPanes[0], { type: 'split', direction: 'vertical', children: eightPanes.slice(1, 4) },
      { type: 'split', direction: 'horizontal', children: eightPanes.slice(4) },
    ] };
    const { leaves, dividers } = getPaneTreeGeometry(root, width, height);
    expect(leaves.map(({ pane }) => pane.id)).toEqual(eightPanes.map(pane => pane.id));
    for (const { rect } of [...leaves, ...dividers]) {
      expect(Object.values(rect).every(Number.isFinite)).toBe(true);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(width + 1e-7);
      expect(rect.top + rect.height).toBeLessThanOrEqual(height + 1e-7);
    }
    for (const { value, min, max } of dividers) {
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(100);
      expect(value).toBeGreaterThanOrEqual(min - 1e-7);
      expect(value).toBeLessThanOrEqual(max + 1e-7);
    }
  });
});

describe('paneTreeFromLegacy', () => {
  it('keeps pane identities and grid row order while migrating layout geometry', () => {
    const root = paneTreeFromLegacy({ type: 'grid', panes });
    expect(root).toEqual({ type: 'split', direction: 'vertical', children: [
      { type: 'split', direction: 'horizontal', children: panes.slice(0, 2) },
      { type: 'split', direction: 'horizontal', children: panes.slice(2) },
    ] });
    expect(root.children[0].children[0]).toBe(panes[0]);
  });
});
