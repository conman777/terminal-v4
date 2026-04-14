import { useEffect } from 'react';

export function isIOSViewportZoomBrowser() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchCapableMac = platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;

  return /iPad|iPhone|iPod/i.test(userAgent) || touchCapableMac;
}

export function buildViewportMetaContent(content, lockZoom) {
  const tokens = String(content || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^maximum-scale=/i.test(token) && !/^user-scalable=/i.test(token));

  if (lockZoom) {
    tokens.push('maximum-scale=1');
    tokens.push('user-scalable=no');
  }

  return tokens.join(', ');
}

export function useMobileInputZoomLock(enabled) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || !isIOSViewportZoomBrowser()) {
      return undefined;
    }

    const viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!(viewportMeta instanceof HTMLMetaElement)) {
      return undefined;
    }

    const originalContent = viewportMeta.getAttribute('content') || '';
    const lockedContent = buildViewportMetaContent(originalContent, true);

    viewportMeta.setAttribute('content', lockedContent);

    return () => {
      viewportMeta.setAttribute('content', originalContent);
    };
  }, [enabled]);
}
