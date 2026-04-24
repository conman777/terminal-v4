import { describe, expect, it } from 'vitest';
import { resolveStartupWorkspacePath } from './startupWorkspace';

describe('resolveStartupWorkspacePath', () => {
  it('prefers the active project cwd when available', () => {
    expect(resolveStartupWorkspacePath('C:\\repo\\active', ['C:\\repo\\recent'])).toBe('C:\\repo\\active');
  });

  it('falls back to the first recent folder when there is no active project cwd', () => {
    expect(resolveStartupWorkspacePath('', ['C:\\repo\\recent', 'C:\\repo\\older'])).toBe('C:\\repo\\recent');
  });

  it('returns an empty string when neither source provides a workspace', () => {
    expect(resolveStartupWorkspacePath(null, [])).toBe('');
  });
});
