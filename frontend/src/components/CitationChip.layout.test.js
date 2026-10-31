import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/components/LightweightMarkdown.css', 'utf8');
const rule = css.split('}').find(block => /\.lightweight-markdown\s+\.md-citation\s*\{/.test(block)) || '';
const pixels = property => Number((rule.match(new RegExp(`${property}:\\s*(\\d+)px`)) || [])[1]);

describe('citation chip size', () => {
  it('is at least the 24 by 24 pixel minimum target size of WCAG 2.2', () => {
    expect([pixels('min-height') >= 24, pixels('min-width') >= 24]).toEqual([true, true]);
  });
});
