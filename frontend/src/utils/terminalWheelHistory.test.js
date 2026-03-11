import { describe, expect, it } from 'vitest';
import { shouldCheckHistoryAtTopOnWheel } from './terminalWheelHistory';

describe('shouldCheckHistoryAtTopOnWheel', () => {
  it('checks for more history on desktop non-tmux upward wheel scrolls', () => {
    expect(
      shouldCheckHistoryAtTopOnWheel({
        deltaY: -120,
        isMobile: false,
        usesTmux: false,
        baseY: 0
      })
    ).toBe(true);
  });

  it('does not check for more history on downward wheel scrolls', () => {
    expect(
      shouldCheckHistoryAtTopOnWheel({
        deltaY: 120,
        isMobile: false,
        usesTmux: false,
        baseY: 0
      })
    ).toBe(false);
  });

  it('checks for more history on tmux sessions only when xterm scrollback exists', () => {
    expect(
      shouldCheckHistoryAtTopOnWheel({
        deltaY: -120,
        isMobile: false,
        usesTmux: true,
        baseY: 24
      })
    ).toBe(true);

    expect(
      shouldCheckHistoryAtTopOnWheel({
        deltaY: -120,
        isMobile: false,
        usesTmux: true,
        baseY: 0
      })
    ).toBe(false);
  });
});
