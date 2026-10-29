import { setActiveEnvironment } from './remoteEnvironments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn()
}));

import { toPathPreviewFallbackUrl, toPreviewUrl, withAuthToken } from './previewUrl';

const PREVIEW_PROXY_HOSTS_KEY = 'terminal_preview_proxy_hosts';

describe('toPreviewUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it.each([
    ['file:///tmp/preview%20space/index.html', '/tmp/preview space', 'index.html'],
    ['file:///C:/project%20space/index.html', 'C:/project space', 'index.html'],
    ['file:///tmp/preview%invalid.html', '/tmp', 'preview%invalid.html'],
    ['file:///tmp/preview space 100%.html', '/tmp', 'preview space 100%.html'],
    ['/tmp/preview space # %.html', '/tmp', 'preview space # %.html'],
    [String.raw`C:\project space\index.html`, String.raw`C:\project space`, 'index.html'],
  ])('retains the exact static filesystem target for %s', (input, directory, filename) => {
    const target = new URL(toPreviewUrl(input), window.location.origin);
    expect(target.pathname).toBe('/api/preview');
    expect(target.searchParams.get('path')).toBe(directory);
    expect(target.searchParams.get('file')).toBe(filename);
  });

  it('keeps full access credentials out of known preview URLs while retaining resource grants', () => {
    localStorage.setItem('terminal_access_token', 'full-access-fixture');
    const target = new URL(withAuthToken('/api/preview?path=%2Ftmp&file=index.html&previewToken=resource-grant'), window.location.origin);
    expect(target.searchParams.has('token')).toBe(false);
    expect(target.searchParams.get('previewToken')).toBe('resource-grant');
  });

  it('preserves authentication behavior for API routes outside known preview targets', () => {
    localStorage.setItem('terminal_access_token', 'full-access-fixture');
    const target = new URL(withAuthToken('/api/preview/4173/logs'), window.location.origin);
    expect(target.searchParams.get('token')).toBe('full-access-fixture');
    expect(withAuthToken('https://external.example.com/api/preview')).toBe('https://external.example.com/api/preview');
  });

  it('keeps preview path URLs unchanged', () => {
    expect(toPreviewUrl('/preview/5173/app')).toBe('/preview/5173/app');
  });

  it('uses path-based previews for localhost apps', () => {
    const result = toPreviewUrl('http://localhost:5173/app');
    expect(result).toBe('/preview/5173/app');
  });

  it.each(['http://[::1]:5173/app?fixture=1#selected', 'http://[0:0:0:0:0:0:0:1]:5173/app?fixture=1#selected'])('routes IPv6 loopback through local preview: %s', input => {
    expect(toPreviewUrl(input)).toBe('/preview/5173/app?fixture=1#selected');
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
      const result = toPreviewUrl('http://192.168.1.199:5173/app');
      expect(result).toBe('/preview/5173/app');
    } finally {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('treats configured proxy hosts as local preview targets', () => {
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

describe('paired environment previews', () => {
  it('routes development servers through the selected host and never attaches home auth to an external origin', () => {
    setActiveEnvironment({ id: 'remote-a' });
    try {
      expect(toPreviewUrl('http://localhost:5173/app')).toBe('/api/environments/remote-a/proxy/preview/5173/app');
    } finally { setActiveEnvironment(null); }
  });
});
