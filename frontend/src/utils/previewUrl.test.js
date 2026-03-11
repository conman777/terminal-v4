import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(() => null)
}));

vi.mock('./api', () => ({
  apiFetch: vi.fn()
}));

import { toPathPreviewFallbackUrl, toPreviewUrl } from './previewUrl';

const PREVIEW_SUBDOMAIN_BASE_KEY = 'terminal_preview_subdomain_base';
const PREVIEW_SUBDOMAIN_BASES_KEY = 'terminal_preview_subdomain_bases';
const PREVIEW_DEFAULT_MODE_KEY = 'terminal_preview_default_mode';
const PREVIEW_PREFER_PATH_BASED_KEY = 'terminal_preview_prefer_path_based';
const PREVIEW_PROXY_HOSTS_KEY = 'terminal_preview_proxy_hosts';

describe('toPreviewUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('keeps preview path URLs unchanged', () => {
    expect(toPreviewUrl('/preview/5173/app')).toBe('/preview/5173/app');
  });

  it('uses subdomain-first mode when base is loopback-resolvable', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'subdomain-first');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, '127.0.0.1.nip.io');

    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toContain('preview-5173.127.0.0.1.nip.io');
    expect(result).toContain('/app');
  });

  it('falls back to path mode on loopback when base is not locally resolvable', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'subdomain-first');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, 'conordart.com');

    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toBe('/preview/5173/app');
  });

  it('uses a loopback-safe base from configured bases on localhost', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'subdomain-first');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, 'conordart.com');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASES_KEY, JSON.stringify(['conordart.com', 'localhost']));

    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toBe(`http://preview-5173.localhost:${window.location.port}/app`);
  });

  it('forces path mode when default mode is path-first', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'path-first');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, '127.0.0.1.nip.io');

    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toBe('/preview/5173/app');
  });

  it('honors adaptive preferPathBased flag', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'adaptive');
    localStorage.setItem(PREVIEW_PREFER_PATH_BASED_KEY, 'true');
    localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, '127.0.0.1.nip.io');

    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toBe('/preview/5173/app');
  });

  it('keeps configured subdomain base on 127.0.0.1 host', () => {
    const originalWindow = window;
    const fakeWindow = Object.create(window);
    Object.defineProperty(fakeWindow, 'location', {
      value: {
        ...window.location,
        hostname: '127.0.0.1',
        port: '3020',
        protocol: 'http:',
        origin: 'http://127.0.0.1:3020'
      }
    });
    vi.stubGlobal('window', fakeWindow);

    try {
      localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'subdomain-first');
      localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, '192.168.1.199.nip.io');

      const result = toPreviewUrl('http://localhost:8082');
      expect(result).toBe('http://preview-8082.192.168.1.199.nip.io:3020/');
    } finally {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('keeps remote private IP targets as direct URLs', () => {
    const result = toPreviewUrl('http://192.168.1.45:8889/app');
    expect(result).toBe('http://192.168.1.45:8889/app');
  });

  it('keeps private IP URL without explicit port as direct URL', () => {
    const result = toPreviewUrl('http://192.168.1.45/path');
    expect(result).toBe('http://192.168.1.45/path');
  });

  it('treats private IP as local preview when it matches current UI host', () => {
    const originalWindow = window;
    const fakeWindow = Object.create(window);
    Object.defineProperty(fakeWindow, 'location', {
      value: {
        ...window.location,
        hostname: '192.168.1.199',
        port: '3020',
        protocol: 'http:',
        origin: 'http://192.168.1.199:3020'
      }
    });
    vi.stubGlobal('window', fakeWindow);

    try {
      localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'path-first');

      const result = toPreviewUrl('http://192.168.1.199:5173/app');
      expect(result).toBe('/preview/5173/app');
    } finally {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('treats configured proxy hosts as local preview targets', () => {
    localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, 'path-first');
    localStorage.setItem(PREVIEW_PROXY_HOSTS_KEY, JSON.stringify(['192.168.1.199']));

    const result = toPreviewUrl('http://192.168.1.199:5173/app');
    expect(result).toBe('/preview/5173/app');
  });

  it('converts preview subdomain URL to path fallback URL', () => {
    const result = toPathPreviewFallbackUrl('http://preview-5173.127.0.0.1.nip.io:3020/app?foo=bar');
    expect(result).toBe('/preview/5173/app?foo=bar');
  });

  it('returns null for non-preview host URLs in path fallback helper', () => {
    expect(toPathPreviewFallbackUrl('http://localhost:5173/app')).toBeNull();
  });
});
