import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/components/ThreadCardExtras.css', 'utf8');
const card = readFileSync('src/components/ThreadDetailsCard.css', 'utf8');

describe('thread card extras layout contract (320/390/1280 share one 252px card)', () => {
  it('sizes nothing wider than the card and lets action rows wrap', () => {
    const widths = [...css.matchAll(/(?<!min-|max-)width:\s*(\d+)px/g)].map(match => Number(match[1]));
    expect([card.includes('width: 252px'), Math.max(0, ...widths) <= 252 - 12, /\.thread-pr-actions[^{]*\{[^}]*flex-wrap: wrap/.test(css), css.includes('min-width: 0')]).toEqual([true, true, true, true]);
  });

  it('keeps touch targets at 44px on coarse pointers', () => {
    expect(/pointer: coarse[^{]*\{[^]*min-height: 44px/.test(css)).toBe(true);
  });
});
