import { getAccessToken } from './auth';

/**
 * Add auth token to URL as query parameter
 */
export function withAuthToken(url) {
  const token = getAccessToken();
  if (!token) return url;

  try {
    const fullUrl = new URL(url, window.location.origin);
    if (!fullUrl.searchParams.has('token')) {
      fullUrl.searchParams.set('token', token);
    }
    return `${fullUrl.pathname}${fullUrl.search}${fullUrl.hash}`;
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
}

/**
 * Convert various URL formats to preview-compatible URLs.
 * Handles: file://, Windows paths, Unix paths, localhost, external URLs.
 */
export function toPreviewUrl(inputUrl) {
  if (!inputUrl) return null;

  // Handle file:// URLs
  if (inputUrl.startsWith('file:///')) {
    const filePath = decodeURIComponent(inputUrl.replace('file:///', ''));
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const directory = filePath.substring(0, lastSlash);
    const filename = filePath.substring(lastSlash + 1);
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Windows-style paths (C:\... or C:/...)
  if (/^[A-Za-z]:[/\\]/.test(inputUrl)) {
    const lastSlash = Math.max(inputUrl.lastIndexOf('/'), inputUrl.lastIndexOf('\\'));
    const directory = inputUrl.substring(0, lastSlash);
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Unix-style absolute paths
  if (inputUrl.startsWith('/') && !inputUrl.startsWith('//')) {
    const lastSlash = inputUrl.lastIndexOf('/');
    const directory = inputUrl.substring(0, lastSlash) || '/';
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle localhost/local network URLs - use preview subdomain or local proxy path
  try {
    const parsed = new URL(inputUrl);
    const hostname = parsed.hostname;
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
    const isPrivateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);
    const uiHost = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocalUiHost =
      ['localhost', '127.0.0.1', '0.0.0.0'].includes(uiHost) ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(uiHost);

    if ((isLocalhost || isPrivateIP) && parsed.port) {
      const path = parsed.pathname + parsed.search + parsed.hash;
      if (isLocalUiHost) {
        return `/preview/${parsed.port}${path}`;
      }
      return `https://preview-${parsed.port}.conordart.com${path}`;
    }
  } catch {
    // Not a valid URL, fall through
  }

  // External HTTP(S) URLs - route through proxy
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return withAuthToken(`/api/proxy-external?url=${encodeURIComponent(inputUrl)}`);
    }
  } catch {
    // Not a valid URL
  }

  return inputUrl;
}
