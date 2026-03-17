import { getAccessToken } from './auth';
import { apiFetch } from './api';

const PREVIEW_SUBDOMAIN_BASE_KEY = 'terminal_preview_subdomain_base';
const PREVIEW_SUBDOMAIN_BASES_KEY = 'terminal_preview_subdomain_bases';
const PREVIEW_PREFER_PATH_BASED_KEY = 'terminal_preview_prefer_path_based';
const PREVIEW_DEFAULT_MODE_KEY = 'terminal_preview_default_mode';
const PREVIEW_PROXY_HOSTS_KEY = 'terminal_preview_proxy_hosts';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const PRIVATE_IPV4_PATTERN = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

function normalizeHost(host) {
  return typeof host === 'string' ? host.trim().toLowerCase() : '';
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(normalizeHost(hostname));
}

function isPrivateIpv4Host(hostname) {
  return PRIVATE_IPV4_PATTERN.test(normalizeHost(hostname));
}

function getPreviewDefaultMode() {
  if (typeof window === 'undefined') return 'subdomain-first';
  try {
    const stored = localStorage.getItem(PREVIEW_DEFAULT_MODE_KEY);
    if (stored === 'adaptive' || stored === 'path-first' || stored === 'subdomain-first') {
      return stored;
    }
  } catch {}
  return 'subdomain-first';
}

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

function getPreviewSubdomainBases() {
  if (typeof window === 'undefined') return ['localhost'];

  const configuredBase = getPreviewSubdomainBase();
  try {
    const stored = localStorage.getItem(PREVIEW_SUBDOMAIN_BASES_KEY);
    if (!stored) return [configuredBase];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [configuredBase];

    const normalized = parsed
      .map((host) => (typeof host === 'string' ? host.trim() : ''))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : [configuredBase];
  } catch {
    return [configuredBase];
  }
}

function getPreviewProxyHosts() {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(PREVIEW_PROXY_HOSTS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((host) => normalizeHost(String(host)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isLocalPreviewTarget(hostname, uiHost, proxyHosts) {
  const normalizedTarget = normalizeHost(hostname);
  if (!normalizedTarget) return false;
  if (isLoopbackHost(normalizedTarget)) return true;
  if (normalizedTarget === normalizeHost(uiHost)) return true;
  return proxyHosts.includes(normalizedTarget);
}

function getEffectiveSubdomainBase() {
  const configuredBase = getPreviewSubdomainBase();
  if (typeof window === 'undefined') return configuredBase;
  const configuredBases = getPreviewSubdomainBases();
  const uiHost = window.location.hostname || '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(uiHost)) {
    // On loopback IP, prefer the backend-provided base (if configured) so
    // frontend URL synthesis doesn't drift from backend host constraints.
    if (uiHost === '127.0.0.1') {
      const normalizedConfigured = configuredBase.toLowerCase();
      if (normalizedConfigured && normalizedConfigured !== 'localhost') {
        return configuredBase;
      }
    }
    return `${uiHost}.nip.io`;
  }
  if (isLoopbackHost(uiHost)) {
    const loopbackBase = configuredBases.find((base) => isResolvableLoopbackSubdomainBase(base));
    if (loopbackBase) {
      return loopbackBase;
    }
  }
  return configuredBase;
}

function shouldPreferPathBased() {
  if (typeof window === 'undefined') return false;
  if (window.crossOriginIsolated) return true;
  const defaultMode = getPreviewDefaultMode();
  if (defaultMode === 'path-first') return true;
  if (defaultMode === 'subdomain-first') return false;
  try {
    const stored = localStorage.getItem(PREVIEW_PREFER_PATH_BASED_KEY);
    if (!stored) return false;
    return stored === 'true' || stored === '1' || stored === 'yes';
  } catch {
    return false;
  }
}

function isResolvableLoopbackSubdomainBase(base) {
  if (!base) return false;
  const normalized = base.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'lvh.me' ||
    normalized.endsWith('.lvh.me') ||
    normalized.includes('.nip.io') ||
    normalized.includes('.sslip.io')
  );
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
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && fullUrl.origin !== window.location.origin) {
      return fullUrl.toString();
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
    const isLoopback = isLoopbackHost(hostname);
    const isPrivateIP = isPrivateIpv4Host(hostname);
    const uiProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:';
    const uiHost = typeof window !== 'undefined' ? window.location.hostname : '';
    const uiIsLoopback = isLoopbackHost(uiHost);
    const uiIsIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(uiHost);
    const canUseLocalSubdomain = uiProtocol === 'http:';
    const uiPort = typeof window !== 'undefined' && window.location.port ? `:${window.location.port}` : '';
    const subdomainBase = getEffectiveSubdomainBase();
    const proxyHosts = getPreviewProxyHosts();
    const targetIsLocalPreview = isLocalPreviewTarget(hostname, uiHost, proxyHosts);
    const preferPathBased = shouldPreferPathBased();
    const defaultMode = getPreviewDefaultMode();

    if ((isLoopback || (isPrivateIP && targetIsLocalPreview)) && parsed.port) {
      const path = parsed.pathname + parsed.search + parsed.hash;
      const loopbackSubdomainCapable = !uiIsLoopback || isResolvableLoopbackSubdomainBase(subdomainBase);
      const canUseSubdomain = canUseLocalSubdomain && loopbackSubdomainCapable && Boolean(subdomainBase || uiIsIp);
      const shouldUseSubdomain = defaultMode === 'subdomain-first'
        ? canUseSubdomain
        : (!preferPathBased && canUseSubdomain);
      if (shouldUseSubdomain) {
        return withAuthToken(`http://preview-${parsed.port}.${subdomainBase}${uiPort}${path}`);
      }
      return `/preview/${parsed.port}${path}`;
    }

    // Keep remote private-network URLs as direct iframe targets so they are not
    // incorrectly routed to the local-machine preview proxy.
    if (isPrivateIP && !targetIsLocalPreview) {
      return parsed.toString();
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

/**
 * Convert preview subdomain URL back to path-based preview URL.
 * Returns null when URL is not a preview subdomain URL.
 */
export function toPathPreviewFallbackUrl(inputUrl) {
  if (!inputUrl) return null;
  try {
    const parsed = new URL(inputUrl, window.location.origin);
    const hostMatch = parsed.hostname.match(/^preview-(\d+)\./i);
    if (!hostMatch) return null;
    const port = hostMatch[1];
    const path = parsed.pathname || '/';
    return `/preview/${port}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
