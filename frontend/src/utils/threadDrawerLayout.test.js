import { beforeEach, describe, expect, it } from 'vitest';
import { setUser } from './auth';
import { clampDrawerHeight, clampSplitRatio, drawerLayoutKey, normalizeDrawerLayout, readDrawerLayout, resolveSplitPartner, writeDrawerLayout } from './threadDrawerLayout';

beforeEach(() => { localStorage.clear(); setUser({ id: 'layout-user' }); });

describe('threadDrawerLayout', () => {
  it('clamps ratios and heights to their limits and ignores non-numbers', () => {
    expect([clampSplitRatio(0), clampSplitRatio(2), clampSplitRatio('0.3'), clampSplitRatio('x')]).toEqual([0.2, 0.8, 0.3, 0.5]);
    expect([clampDrawerHeight(10), clampDrawerHeight(5000, 400), clampDrawerHeight(NaN), clampDrawerHeight(300.4)]).toEqual([180, 400, 260, 300]);
  });

  it('rejects stored data that is not a plausible layout', () => {
    expect(normalizeDrawerLayout({ splitId: '../../etc', direction: 'invalid', ratio: 'wide', height: -4 })).toEqual({ splitId: null, direction: 'side-by-side', ratio: 0.5, height: 180 });
    expect(normalizeDrawerLayout('nope')).toEqual({ splitId: null, direction: 'side-by-side', ratio: 0.5, height: 260 });
  });

  it('keeps each thread separate and survives corrupt storage', () => {
    const one = drawerLayoutKey('ss-one'), two = drawerLayoutKey('ss-two');
    writeDrawerLayout(one, { splitId: 'pty-9', direction: 'stacked', ratio: 0.35, height: 320 });
    expect([readDrawerLayout(one), readDrawerLayout(two)]).toEqual([{ splitId: 'pty-9', direction: 'stacked', ratio: 0.35, height: 320 }, { splitId: null, direction: 'side-by-side', ratio: 0.5, height: 260 }]);
    localStorage.setItem(Object.keys(localStorage).find(key => key.includes('ss-one')), '{broken');
    expect(readDrawerLayout(one)).toEqual({ splitId: null, direction: 'side-by-side', ratio: 0.5, height: 260 });
  });

  it('restores a pre-direction layout as side-by-side', () => {
    expect(normalizeDrawerLayout({ splitId: 'pty-9', ratio: 0.4, height: 300 }))
      .toEqual({ splitId: 'pty-9', direction: 'side-by-side', ratio: 0.4, height: 300 });
  });

  it('only treats a split partner as valid while that terminal still exists and is not the primary', () => {
    const layout = { splitId: 'b' };
    expect([resolveSplitPartner(layout, ['a', 'b'], 'a'), resolveSplitPartner(layout, ['a'], 'a'), resolveSplitPartner(layout, ['a', 'b'], 'b')]).toEqual(['b', null, null]);
  });
});
