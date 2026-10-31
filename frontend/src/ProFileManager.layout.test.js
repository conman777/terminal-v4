import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/ProFileManager.css', 'utf8');
const coarse = css.slice(css.indexOf('@media (pointer: coarse), (max-width: 768px)'));

describe('file path breadcrumbs on touch screens', () => {
  it('gives each path segment a 44px wide and tall touch target', () => {
    expect(/\.pro-file-manager \.breadcrumb-item\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/.test(coarse)).toBe(true);
  });
});
