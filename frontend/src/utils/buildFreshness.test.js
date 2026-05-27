import { describe, expect, it } from 'vitest';
import {
  buildFreshReloadUrl,
  getCurrentMainScriptPath,
  normalizeAssetPath,
  shouldReloadForBuild,
} from './buildFreshness';

describe('buildFreshness', () => {
  it('finds the currently loaded Vite entry script', () => {
    const documentRef = document.implementation.createHTMLDocument();
    const vendor = documentRef.createElement('script');
    vendor.src = '/assets/vendor-react.js';
    const main = documentRef.createElement('script');
    main.src = '/assets/index-OLD123.js';
    documentRef.body.append(vendor, main);

    expect(getCurrentMainScriptPath(documentRef, 'https://example.test/app')).toBe('/assets/index-OLD123.js');
  });

  it('detects stale clients when the server reports a different entry script', () => {
    expect(shouldReloadForBuild('/assets/index-OLD123.js', {
      mainScript: '/assets/index-NEW456.js'
    })).toBe(true);

    expect(shouldReloadForBuild('/assets/index-NEW456.js', {
      mainScript: '/assets/index-NEW456.js'
    })).toBe(false);
  });

  it('builds a cache-busting reload URL for mobile Safari', () => {
    const locationRef = new URL('https://example.test/terminal?thread=1');
    const reloadUrl = buildFreshReloadUrl(locationRef, '/assets/index-NEW456.js');

    expect(reloadUrl).toContain('https://example.test/terminal?thread=1');
    expect(reloadUrl).toContain('_v4_build=');
    expect(normalizeAssetPath('https://example.test/assets/index-NEW456.js')).toBe('/assets/index-NEW456.js');
  });
});
