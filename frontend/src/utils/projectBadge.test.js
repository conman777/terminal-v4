import { describe, expect, it } from 'vitest';
import { getProjectBadge, projectNameFromPath } from './projectBadge';

describe('getProjectBadge', () => {
  it('abbreviates project names the way T3 Code badges them', () => {
    const names = ['terminal-v4', 'prompt-blueprints', 'AIAudit', 'conordart', '', null];
    expect(names.map(name => getProjectBadge(name).initials)).toEqual(['TV', 'PB', 'AA', 'CO', '?', '?']);
  });

  it('gives each project a stable hue so its badge colour never changes between renders', () => {
    const hues = ['terminal-v4', 'terminal-v4', 'prompt-blueprints'].map(name => getProjectBadge(name).hue);
    expect([hues[0] === hues[1], hues[0] === hues[2], hues.every(hue => Number.isInteger(hue) && hue >= 0 && hue < 360)]).toEqual([true, false, true]);
  });
});

describe('projectNameFromPath', () => {
  it('names a project after its folder on any platform', () => {
    expect(['/Users/me/terminal-v4/', 'C:\\work\\api', '', null].map(projectNameFromPath)).toEqual(['terminal-v4', 'api', '', '']);
  });
});
