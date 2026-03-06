import { describe, expect, it } from 'vitest';
import { isIgnorableTmuxListError } from './tmux-manager';

describe('isIgnorableTmuxListError', () => {
  it('treats missing tmux socket errors as ignorable', () => {
    expect(
      isIgnorableTmuxListError({
        stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\n'
      })
    ).toBe(true);
  });

  it('treats no-server-running errors as ignorable', () => {
    expect(
      isIgnorableTmuxListError({
        stderr: 'no server running on /tmp/tmux-501/default\n'
      })
    ).toBe(true);
  });

  it('keeps unexpected tmux errors visible', () => {
    expect(
      isIgnorableTmuxListError({
        stderr: 'permission denied\n'
      })
    ).toBe(false);
  });
});
