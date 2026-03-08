import { describe, expect, it } from 'vitest';
import {
  getTerminalRendererGuardReason,
  isLinuxDesktopBrowser,
  resolveTerminalWebglEnabled,
} from './terminalRendererPolicy';

function createNavigator(overrides = {}) {
  return {
    userAgent: '',
    platform: '',
    userAgentData: undefined,
    ...overrides,
  };
}

describe('terminalRendererPolicy', () => {
  it('disables WebGL on Linux desktop browsers', () => {
    const navigatorLike = createNavigator({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
    });

    expect(isLinuxDesktopBrowser(navigatorLike)).toBe(true);
    expect(resolveTerminalWebglEnabled(true, navigatorLike)).toBe(false);
    expect(getTerminalRendererGuardReason(navigatorLike)).toContain('Linux');
  });

  it('preserves an explicit canvas preference on supported platforms', () => {
    const navigatorLike = createNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      platform: 'Win32',
    });

    expect(isLinuxDesktopBrowser(navigatorLike)).toBe(false);
    expect(resolveTerminalWebglEnabled(false, navigatorLike)).toBe(false);
  });

  it('does not classify Android browsers as Linux desktop', () => {
    const navigatorLike = createNavigator({
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv81',
    });

    expect(isLinuxDesktopBrowser(navigatorLike)).toBe(false);
    expect(resolveTerminalWebglEnabled(true, navigatorLike)).toBe(true);
    expect(getTerminalRendererGuardReason(navigatorLike)).toBeNull();
  });
});
