import { describe, expect, it } from 'vitest';
import { getCompactSessionSubtitle, getSessionDisplayInfo, getSessionFallbackLabel } from './sessionDisplay';

describe('sessionDisplay', () => {
  it('falls back to the project folder when the title is a raw path', () => {
    const session = {
      title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      thread: { topic: '' }
    };

    expect(getSessionFallbackLabel(session)).toBe('uplifting');
    expect(getSessionDisplayInfo(session)).toMatchObject({
      primaryLabel: 'uplifting',
      secondaryLabel: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      projectName: 'uplifting',
    });
  });

  it('prefers the meaningful topic and keeps the project as secondary context', () => {
    const session = {
      title: 'Terminal 5',
      cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
      thread: { topic: 'discard local changes' }
    };

    expect(getSessionDisplayInfo(session)).toMatchObject({
      primaryLabel: 'discard local changes',
      secondaryLabel: 'terminal v4',
      projectName: 'terminal v4',
    });
  });

  it('returns a compact subtitle that prefers the project name over full paths', () => {
    const session = {
      title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      thread: { topic: 'ship the mobile header' }
    };

    expect(getCompactSessionSubtitle(session)).toBe('uplifting');
  });
});
