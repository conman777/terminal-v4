import { getAccessToken } from './auth';
import { apiFetch } from './api';

const PREVIEW_SUBDOMAIN_BASE_KEY = 'terminal_preview_subdomain_base';
const PREVIEW_SUBDOMAIN_BASES_KEY = 'terminal_preview_subdomain_bases';

/**
 * Extract port number from a URL string.
 * Handles localhost URLs, preview paths, and subdomain patterns.
 * Priority order: preview path > subdomain > URL port > localhost pattern
 * @param {string} url - The URL to extract port from
 * @returns {number|null} - The port number (1-65535) or null if not found/invalid
 */
export function extractPortFromUrl(url) {
  if (!url) return null;

  const validatePort = (port) => {
    const num = parseInt(port, 10);
    return num >= 1 && num <= 65535 ? num : null;
  };

  try {
    // Handle /preview/PORT/ path format (highest priority - internal routes)
    const previewPathMatch = url.match(/\/preview\/(\d+)/);
    if (previewPathMatch) {
      return validatePort(previewPathMatch[1]);
    }

    // Handle preview-PORT.domain subdomain format
    const subdomainMatch = url.match(/preview-(\d+)\./);
    if (subdomainMatch) {
      return validatePort(subdomainMatch[1]);
    }

    // Handle standard URL with port
    const parsed = new URL(url, window.location.origin);
    if (parsed.port) {
      return validatePort(parsed.port);
    }

    // Check for localhost:PORT in the URL string directly
    const localhostMatch = url.match(/localhost:(\d+)/);
    if (localhostMatch) {
      return validatePort(localhostMatch[1]);
    }
  } catch {
    // Invalid URL
  }

  return null;
}

/**
 * Fetch all active ports with their listening status.
 * @returns {Promise<Array<{port: number, listening: boolean}>>} - Array of port info
 */
export async function getActivePortsInfo() {
  try {
    const response = await apiFetch('/api/preview/active-ports');
    if (!response.ok) return [];

    const data = await response.json();
    return data.ports || [];
  } catch {
    return [];
  }
}

function getPreviewSubdomainBase() {
  if (typeof window === 'undefined') return 'localhost';
  try {
    const stored = localStorage.getItem(PREVIEW_SUBDOMAIN_BASE_KEY);
    if (stored) return stored;
    const basesRaw = localStorage.getItem(PREVIEW_SUBDOMAIN_BASES_KEY);
    if (basesRaw) {
      const bases = JSON.parse(basesRaw);
      if (Array.isArray(bases) && bases.length > 0) {
        return bases[0];
      }
    }
  } catch {}
  return 'localhost';
}

function getEffectiveSubdomainBase() {
  if (typeof window === 'undefined') return getPreviewSubdomainBase();
  const uiHost = window.location.hostname || '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(uiHost)) {
    return `${uiHost}.nip.io`;
  }
  return getPreviewSubdomainBase();
}

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
  let normalizedInput = inputUrl.trim();

  // Add http:// for host:port inputs like localhost:3000
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedInput)) {
    const hostPortMatch = /^[^/\s]+:\d+(?:\/|\?|#|$)/.test(normalizedInput);
    if (hostPortMatch) {
      normalizedInput = `http://${normalizedInput}`;
    }
  }

  // Keep preview path URLs intact
  if (normalizedInput.startsWith('/preview/') || normalizedInput.startsWith('/api/preview')) {
    return normalizedInput;
  }

  // Handle file:// URLs
  if (normalizedInput.startsWith('file:///')) {
    const filePath = decodeURIComponent(normalizedInput.replace('file:///', ''));
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const directory = filePath.substring(0, lastSlash);
    const filename = filePath.substring(lastSlash + 1);
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Windows-style paths (C:\... or C:/...)
  if (/^[A-Za-z]:[/\\]/.test(normalizedInput)) {
    const lastSlash = Math.max(normalizedInput.lastIndexOf('/'), normalizedInput.lastIndexOf('\\'));
    const directory = normalizedInput.substring(0, lastSlash);
    const filename = normalizedInput.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Unix-style absolute paths
  if (normalizedInput.startsWith('/') && !normalizedInput.startsWith('//')) {
    const lastSlash = normalizedInput.lastIndexOf('/');
    const directory = normalizedInput.substring(0, lastSlash) || '/';
    const filename = normalizedInput.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle localhost/local network URLs - use preview subdomain or local proxy path
  try {
    const parsed = new URL(normalizedInput);
    const uiOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    if (uiOrigin && parsed.origin === uiOrigin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const hostname = parsed.hostname;
    const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname);
    const isPrivateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);
    const uiProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:';
    const uiHost = typeof window !== 'undefined' ? window.location.hostname : '';
    const uiIsLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(uiHost);
    const uiIsIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(uiHost);
    const canUseLocalSubdomain = uiProtocol === 'http:';
    const uiPort = typeof window !== 'undefined' && window.location.port ? `:${window.location.port}` : '';
    const subdomainBase = getEffectiveSubdomainBase();

    if ((isLoopback || isPrivateIP) && parsed.port) {
      const path = parsed.pathname + parsed.search + parsed.hash;
      const hasConfiguredSubdomainBase = subdomainBase && subdomainBase !== 'localhost';
      // Use subdomain only when NOT on localhost - localhost subdomains don't resolve
      // without extra DNS config. Path-based preview works reliably everywhere.
      const canUseSubdomain = canUseLocalSubdomain && !uiIsLoopback && (uiIsIp || hasConfiguredSubdomainBase);
      if (canUseSubdomain) {
        return `http://preview-${parsed.port}.${subdomainBase}${uiPort}${path}`;
      }
      return `/preview/${parsed.port}${path}`;
    }
  } catch {
    // Not a valid URL, fall through
  }

  // External HTTP(S) URLs - route through proxy
  try {
    const parsed = new URL(normalizedInput);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return withAuthToken(`/api/proxy-external?url=${encodeURIComponent(normalizedInput)}`);
    }
  } catch {
    // Not a valid URL
  }

  return normalizedInput;
}
