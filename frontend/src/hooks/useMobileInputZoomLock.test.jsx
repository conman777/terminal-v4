import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildViewportMetaContent,
  isIOSViewportZoomBrowser,
  useMobileInputZoomLock
} from './useMobileInputZoomLock';

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalMaxTouchPoints = navigator.maxTouchPoints;

function mockNavigator({ userAgent = originalUserAgent, platform = originalPlatform, maxTouchPoints = originalMaxTouchPoints } = {}) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  });
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: maxTouchPoints
  });
}

describe('buildViewportMetaContent', () => {
  it('adds the iOS zoom lock directives without dropping existing viewport options', () => {
    expect(buildViewportMetaContent('width=device-width, initial-scale=1, viewport-fit=cover', true))
      .toBe('width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no');
  });

  it('removes stale zoom directives before rebuilding the viewport content', () => {
    expect(buildViewportMetaContent('width=device-width, maximum-scale=5, user-scalable=yes', true))
      .toBe('width=device-width, maximum-scale=1, user-scalable=no');
  });
});

describe('isIOSViewportZoomBrowser', () => {
  afterEach(() => {
    mockNavigator({});
  });

  it('detects iPhone browsers', () => {
    mockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5
    });

    expect(isIOSViewportZoomBrowser()).toBe(true);
  });

  it('ignores Android browsers', () => {
    mockNavigator({
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      maxTouchPoints: 5
    });

    expect(isIOSViewportZoomBrowser()).toBe(false);
  });
});

describe('useMobileInputZoomLock', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    mockNavigator({});
  });

  it('locks and restores the viewport meta while mobile text entry is focused on iOS', () => {
    mockNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5
    });

    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
    document.head.appendChild(meta);

    const { rerender, unmount } = renderHook(({ enabled }) => useMobileInputZoomLock(enabled), {
      initialProps: { enabled: false }
    });

    expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');

    rerender({ enabled: true });
    expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content, maximum-scale=1, user-scalable=no');

    rerender({ enabled: false });
    expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');

    rerender({ enabled: true });
    unmount();
    expect(meta.content).toBe('width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
  });
});
