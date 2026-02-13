import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import WebSocket from 'ws';
import { Readable } from 'node:stream';
import { INSPECTOR_SCRIPT } from '../inspector/inspector-script.js';
import { storeCookies, getCookieHeader, clearCookies, listCookies, hasCookies, getCookieNamesForDeletion } from '../preview/cookie-store.js';
import { rewriteSetCookieHeaders } from '../preview/cookie-rewrite.js';
import { addProxyLog, filterHeaders, truncateBody } from '../preview/request-log-store.js';
import { logWebSocketConnection, logWebSocketMessage } from '../preview/websocket-interceptor.js';

const PREVIEW_SUBDOMAIN_BASES = (process.env.PREVIEW_SUBDOMAIN_BASES || process.env.PREVIEW_SUBDOMAIN_BASE || 'conordart.com,localhost')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const PREVIEW_SUBDOMAIN_BASE = PREVIEW_SUBDOMAIN_BASES[0] || 'conordart.com';
const PREVIEW_PROXY_HOSTS = (process.env.PREVIEW_PROXY_HOSTS || 'localhost,127.0.0.1,::1')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
type PreviewCookiePolicy = 'preserve-upstream' | 'compat-rewrite' | 'force-none';
type PreviewRewriteScope = 'minimal' | 'hybrid' | 'legacy';

function parsePreviewCookiePolicy(value: string | undefined): PreviewCookiePolicy {
  if (value === 'compat-rewrite' || value === 'force-none') return value;
  return 'preserve-upstream';
}

function parsePreviewRewriteScope(value: string | undefined): PreviewRewriteScope {
  if (value === 'hybrid' || value === 'legacy') return value;
  return 'minimal';
}

const PREVIEW_COOKIE_POLICY = parsePreviewCookiePolicy(process.env.PREVIEW_COOKIE_POLICY);
const PREVIEW_REWRITE_SCOPE = parsePreviewRewriteScope(process.env.PREVIEW_REWRITE_SCOPE);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pattern to match preview subdomains: preview-{port}.<base>
const PREVIEW_SUBDOMAIN_PATTERN = new RegExp(
  `^preview-(\\d+)\\.(?:${PREVIEW_SUBDOMAIN_BASES.map(escapeRegExp).join('|')})$`,
  'i'
);
const PREVIEW_PATH_PATTERN = /^\/preview\/(\d+)(\/.*)?$/;
const APP_PORT = (() => {
  const parsed = Number.parseInt(process.env.PORT || '3020', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3020;
})();
const UNRESTRICTED_PREVIEW = process.env.UNRESTRICTED_PREVIEW !== 'false';
const PREVIEW_PORT_RANGE = UNRESTRICTED_PREVIEW ? { min: 1, max: 65535 } : { min: 3000, max: 9999 };
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit for response buffering
const RESPONSE_READ_TIMEOUT = 30000; // 30 second timeout for reading responses

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function shouldRetryProxyError(message: string): boolean {
  return message.includes('ECONNREFUSED') ||
    message.includes('fetch failed') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('EHOSTUNREACH');
}

async function fetchWithHostFallback(
  port: number,
  requestPath: string,
  options: RequestInit
): Promise<{ response: Response; upstreamHost: string }> {
  let lastError: unknown = null;
  for (const host of PREVIEW_PROXY_HOSTS) {
    const targetUrl = `http://${formatHostForUrl(host)}:${port}${requestPath}`;
    try {
      const response = await fetch(targetUrl, options);
      return { response, upstreamHost: host };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldRetryProxyError(message)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('Preview proxy failed');
}

// Headers to skip when forwarding
const SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'http2-settings'
]);

const WS_SKIP_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol'
]);

function getPreviewHostConstraint(): RegExp {
  return PREVIEW_SUBDOMAIN_PATTERN;
}

// Debug script injected into HTML pages
// Captures console logs, errors, and network requests
// Sends to both postMessage (browser UI) and backend API (for Claude Code)
const PREVIEW_DEBUG_SCRIPT = `
<script>
(function() {
  if (window.__previewDebugInjected) return;
  window.__previewDebugInjected = true;

  var rawPathnameGetter = null;
  var rawHrefGetter = null;
  var rawOriginGetter = null;
  var rawHostGetter = null;
  var rawHostnameGetter = null;
  var rawPortGetter = null;
  try {
    var rawLocationProto = Object.getPrototypeOf(window.location);
    var rawPathnameDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'pathname');
    if (rawPathnameDescriptor && rawPathnameDescriptor.get) {
      rawPathnameGetter = rawPathnameDescriptor.get;
    }
    var rawHrefDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'href');
    if (rawHrefDescriptor && rawHrefDescriptor.get) {
      rawHrefGetter = rawHrefDescriptor.get;
    }
    var rawOriginDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'origin');
    if (rawOriginDescriptor && rawOriginDescriptor.get) {
      rawOriginGetter = rawOriginDescriptor.get;
    }
    var rawHostDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'host');
    if (rawHostDescriptor && rawHostDescriptor.get) {
      rawHostGetter = rawHostDescriptor.get;
    }
    var rawHostnameDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'hostname');
    if (rawHostnameDescriptor && rawHostnameDescriptor.get) {
      rawHostnameGetter = rawHostnameDescriptor.get;
    }
    var rawPortDescriptor = Object.getOwnPropertyDescriptor(rawLocationProto, 'port');
    if (rawPortDescriptor && rawPortDescriptor.get) {
      rawPortGetter = rawPortDescriptor.get;
    }
  } catch (e) {}

  function getRawPathname() {
    try {
      if (rawPathnameGetter) {
        return rawPathnameGetter.call(window.location);
      }
    } catch (e) {}
    return location.pathname;
  }

  function getRawHref() {
    try {
      if (rawHrefGetter) {
        return rawHrefGetter.call(window.location);
      }
    } catch (e) {}
    return location.href;
  }

  function getRawOrigin() {
    try {
      if (rawOriginGetter) {
        return rawOriginGetter.call(window.location);
      }
    } catch (e) {}
    return location.origin;
  }

  function getRawHost() {
    try {
      if (rawHostGetter) {
        return rawHostGetter.call(window.location);
      }
    } catch (e) {}
    return location.host;
  }

  function getRawHostname() {
    try {
      if (rawHostnameGetter) {
        return rawHostnameGetter.call(window.location);
      }
    } catch (e) {}
    return location.hostname;
  }

  function getRawPort() {
    try {
      if (rawPortGetter) {
        return rawPortGetter.call(window.location);
      }
    } catch (e) {}
    return location.port;
  }

  try {
    window.__previewGetRawPathname = getRawPathname;
  } catch (e) {}

  function getPreviewContext() {
    const hostMatch = location.hostname.match(/^preview-(\\d+)\\.(.+)$/i);
    if (hostMatch) {
      return { port: hostMatch[1], mainDomain: hostMatch[2], basePath: '' };
    }
    const pathMatch = getRawPathname().match(/^\\/preview\\/(\\d+)(\\/|$)/);
    if (pathMatch) {
      return { port: pathMatch[1], mainDomain: location.host, basePath: '/preview/' + pathMatch[1] };
    }
    return null;
  }

  const ctx = getPreviewContext();
  if (!ctx) return;
  const PORT = ctx.port;
  const MAIN_DOMAIN = ctx.mainDomain;
  const PREVIEW_BASE_PATH = ctx.basePath;
  const PREVIEW_ORIGIN = location.origin;
  const VIRTUAL_PROTOCOL = PREVIEW_ORIGIN.startsWith('https:') ? 'https:' : 'http:';
  const VIRTUAL_ORIGIN = VIRTUAL_PROTOCOL + '//localhost:' + PORT;
  const SHOULD_NAMESPACE_STORAGE = !!PREVIEW_BASE_PATH;
  var lastReportedLocation = null;

  function stripPreviewBasePath(path) {
    if (!path) return '/';
    if (PREVIEW_BASE_PATH && path.indexOf(PREVIEW_BASE_PATH) === 0) {
      var stripped = path.slice(PREVIEW_BASE_PATH.length);
      return stripped.startsWith('/') ? stripped : '/' + stripped;
    }
    return path;
  }

  function stripPreviewBaseFromHref(href) {
    if (!href || !PREVIEW_BASE_PATH) return href;
    try {
      var parsed = new URL(href, PREVIEW_ORIGIN);
      var rawPath = parsed.pathname || '/';
      var strippedPath = stripPreviewBasePath(rawPath);
      return VIRTUAL_ORIGIN + strippedPath + parsed.search + parsed.hash;
    } catch (e) {}
    return href;
  }

  // Ensure relative links resolve under /preview/:port when path-based preview is active.
  if (PREVIEW_BASE_PATH && typeof document !== 'undefined') {
    try {
      if (!document.querySelector('base')) {
        var base = document.createElement('base');
        base.href = PREVIEW_BASE_PATH + '/';
        if (document.head) {
          document.head.prepend(base);
        }
      }
    } catch (e) {}
  }

  if (PREVIEW_BASE_PATH) {
    try {
      var locationProto = Object.getPrototypeOf(window.location);
      var pathnameDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'pathname');
      if (pathnameDescriptor && pathnameDescriptor.get && pathnameDescriptor.configurable) {
        var originalPathnameGetter = pathnameDescriptor.get;
        Object.defineProperty(locationProto, 'pathname', {
          get: function() {
            try {
              return stripPreviewBasePath(originalPathnameGetter.call(this));
            } catch (e) {}
            return stripPreviewBasePath('');
          },
          configurable: true,
          enumerable: pathnameDescriptor.enumerable
        });
      }

      var originDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'origin');
      if (originDescriptor && originDescriptor.configurable) {
        Object.defineProperty(locationProto, 'origin', {
          get: function() {
            return VIRTUAL_ORIGIN;
          },
          configurable: true,
          enumerable: originDescriptor.enumerable
        });
      }

      var hostDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'host');
      if (hostDescriptor && hostDescriptor.configurable) {
        Object.defineProperty(locationProto, 'host', {
          get: function() {
            return 'localhost:' + PORT;
          },
          configurable: true,
          enumerable: hostDescriptor.enumerable
        });
      }

      var hostnameDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'hostname');
      if (hostnameDescriptor && hostnameDescriptor.configurable) {
        Object.defineProperty(locationProto, 'hostname', {
          get: function() {
            return 'localhost';
          },
          configurable: true,
          enumerable: hostnameDescriptor.enumerable
        });
      }

      var portDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'port');
      if (portDescriptor && portDescriptor.configurable) {
        Object.defineProperty(locationProto, 'port', {
          get: function() {
            return String(PORT);
          },
          configurable: true,
          enumerable: portDescriptor.enumerable
        });
      }
    } catch (e) {}
  }

  // Prevent preview apps from registering service workers with scope "/"
  // which can hijack the Terminal UI origin and wipe auth storage.
  if (SHOULD_NAMESPACE_STORAGE && navigator && navigator.serviceWorker) {
    try {
      var originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function(scriptURL, options) {
        var opts = options || {};
        if (!opts.scope || opts.scope === '/') {
          opts = Object.assign({}, opts, { scope: PREVIEW_BASE_PATH + '/' });
        }
        return originalRegister(scriptURL, opts);
      };

      if (navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
          regs.forEach(function(reg) {
            var scope = reg && reg.scope ? reg.scope : '';
            var scriptUrl = reg && reg.active && reg.active.scriptURL ? reg.active.scriptURL : '';
            if (scope === PREVIEW_ORIGIN + '/' && scriptUrl.indexOf(PREVIEW_BASE_PATH) !== -1) {
              reg.unregister();
            }
          });
        }).catch(function() {});
      }
    } catch (e) {}
  }

  // In path-based preview (/preview/:port), Web Storage shares the same origin
  // as the Terminal UI. Namespace both localStorage and sessionStorage keys
  // to avoid clobbering auth/session state outside the preview app.
  if (SHOULD_NAMESPACE_STORAGE && typeof Storage !== 'undefined') {
    (function() {
      var STORAGE_PREFIX = '__preview_' + PORT + '__';
      var originalGetItem = Storage.prototype.getItem;
      var originalSetItem = Storage.prototype.setItem;
      var originalRemoveItem = Storage.prototype.removeItem;
      var originalClear = Storage.prototype.clear;
      var originalKey = Storage.prototype.key;

      function shouldNamespaceStorage(storage) {
        if (!storage) return false;
        if (storage === localStorage) return true;
        try {
          return typeof sessionStorage !== 'undefined' && storage === sessionStorage;
        } catch (e) {
          return false;
        }
      }

      function getPrefixedKeys(storage) {
        var keys = [];
        try {
          for (var i = 0; i < storage.length; i++) {
            var rawKey = originalKey.call(storage, i);
            if (rawKey && rawKey.indexOf(STORAGE_PREFIX) === 0) {
              keys.push(rawKey.slice(STORAGE_PREFIX.length));
            }
          }
        } catch (e) {}
        return keys;
      }

      Storage.prototype.getItem = function(key) {
        if (shouldNamespaceStorage(this)) {
          return originalGetItem.call(this, STORAGE_PREFIX + key);
        }
        return originalGetItem.call(this, key);
      };

      Storage.prototype.setItem = function(key, value) {
        if (shouldNamespaceStorage(this)) {
          return originalSetItem.call(this, STORAGE_PREFIX + key, value);
        }
        return originalSetItem.call(this, key, value);
      };

      Storage.prototype.removeItem = function(key) {
        if (shouldNamespaceStorage(this)) {
          return originalRemoveItem.call(this, STORAGE_PREFIX + key);
        }
        return originalRemoveItem.call(this, key);
      };

      Storage.prototype.clear = function() {
        if (shouldNamespaceStorage(this)) {
          var keys = getPrefixedKeys(this);
          for (var i = 0; i < keys.length; i++) {
            originalRemoveItem.call(this, STORAGE_PREFIX + keys[i]);
          }
          return;
        }
        return originalClear.call(this);
      };

      Storage.prototype.key = function(index) {
        if (shouldNamespaceStorage(this)) {
          var keys = getPrefixedKeys(this);
          return keys[index] || null;
        }
        return originalKey.call(this, index);
      };
    })();
  }

  function getCanonicalLocation() {
    var path = stripPreviewBasePath(getRawPathname());
    if (!path) path = '/';
    return 'http://localhost:' + PORT + path + location.search + location.hash;
  }

  function reportLocationChange() {
    try {
      var canonicalUrl = getCanonicalLocation();
      if (canonicalUrl === lastReportedLocation) return;
      lastReportedLocation = canonicalUrl;
      window.parent.postMessage({
        type: 'preview-location',
        url: canonicalUrl
      }, '*');
    } catch (e) {}
  }

  function rewriteNavigationUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    var urlStr = '';
    try { urlStr = String(rawUrl); } catch (e) { return rawUrl; }
    if (!urlStr) return urlStr;

    // Absolute URL
    if (/^https?:\\/\\//i.test(urlStr)) {
      try {
        var parsed = new URL(urlStr);

        // Same-origin URL (Terminal V4 origin) - keep preview base path in place
        if (PREVIEW_BASE_PATH && parsed.origin === PREVIEW_ORIGIN) {
          var path = parsed.pathname + parsed.search + parsed.hash;
          return PREVIEW_ORIGIN + withPreviewBasePath(path);
        }

        // Localhost URL matching preview port
        if (isLocalHost(parsed.hostname) && String(parsed.port || '') === String(PORT)) {
          var path = parsed.pathname + parsed.search + parsed.hash;
          return PREVIEW_ORIGIN + withPreviewBasePath(path);
        }
      } catch (e) {}
      return urlStr;
    }

    // Root-relative
    if (urlStr.startsWith('/') && !urlStr.startsWith('//')) {
      return withPreviewBasePath(urlStr);
    }

    return urlStr;
  }

  function hookHistoryMethod(methodName) {
    var original = history[methodName];
    if (typeof original !== 'function') return;
    history[methodName] = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 2 && args[2]) {
        var rawUrl = args[2];
        try {
          if (typeof rawUrl !== 'string' && rawUrl.toString) {
            rawUrl = rawUrl.toString();
          }
        } catch (e) {}
        if (typeof rawUrl === 'string') {
          var rewritten = rewriteNavigationUrl(rawUrl);
          if (rewritten && rewritten !== rawUrl) {
            args[2] = rewritten;
          }
        }
      }
      var result = original.apply(this, args);
      reportLocationChange();
      return result;
    };
  }

  try {
    if (typeof window !== 'undefined' && window.location) {
      var originalAssign = window.location.assign.bind(window.location);
      var originalReplace = window.location.replace.bind(window.location);
      window.location.assign = function(url) {
        return originalAssign(rewriteNavigationUrl(url));
      };
      window.location.replace = function(url) {
        return originalReplace(rewriteNavigationUrl(url));
      };
    }
  } catch (e) {}

  // Intercept location.href setter (best-effort)
  try {
    var locationProto = Object.getPrototypeOf(window.location);
    var hrefDescriptor = Object.getOwnPropertyDescriptor(locationProto, 'href');
    if (hrefDescriptor && hrefDescriptor.set && hrefDescriptor.configurable) {
      var originalHrefSetter = hrefDescriptor.set;
      Object.defineProperty(locationProto, 'href', {
        get: function() {
          try {
            if (rawHrefGetter) {
              return stripPreviewBaseFromHref(rawHrefGetter.call(this));
            }
          } catch (e) {}
          try {
            if (hrefDescriptor.get) {
              return stripPreviewBaseFromHref(hrefDescriptor.get.call(this));
            }
          } catch (e) {}
          return stripPreviewBaseFromHref('');
        },
        set: function(url) {
          return originalHrefSetter.call(this, rewriteNavigationUrl(url));
        },
        configurable: true,
        enumerable: hrefDescriptor.enumerable
      });
    }
  } catch (e) {
    // Some browsers block modifying location prototype
  }

  hookHistoryMethod('pushState');
  hookHistoryMethod('replaceState');
  window.addEventListener('popstate', reportLocationChange);
  window.addEventListener('hashchange', reportLocationChange);
  window.addEventListener('load', reportLocationChange);
  reportLocationChange();

  // Path escape guard: if we're in path-based preview but URL doesn't have prefix, redirect
  if (PREVIEW_BASE_PATH) {
    try {
      var currentPath = getRawPathname() + location.search + location.hash;
      var correctedPath = withPreviewBasePath(currentPath);
      if (correctedPath !== currentPath) {
        location.replace(PREVIEW_ORIGIN + correctedPath);
      }
    } catch (e) {}
  }

  var storageSyncTimeout = null;

  function readStorageSnapshot(storage) {
    try {
      var data = {};
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key) {
          data[key] = storage.getItem(key);
        }
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function sendStorageSync() {
    function readCookiesSnapshot() {
      var cookies = {};
      try {
        var cookieString = document.cookie || '';
        if (!cookieString) return cookies;
        cookieString.split(';').forEach(function(part) {
          var idx = part.indexOf('=');
          if (idx <= 0) return;
          var cookieKey = part.slice(0, idx).trim();
          var cookieValue = part.slice(idx + 1).trim();
          if (!cookieKey) return;
          try {
            cookies[cookieKey] = decodeURIComponent(cookieValue);
          } catch (e) {
            cookies[cookieKey] = cookieValue;
          }
        });
      } catch (e) {}
      return cookies;
    }

    try {
      var localSnapshot = typeof localStorage !== 'undefined' ? readStorageSnapshot(localStorage) : null;
      var sessionSnapshot = typeof sessionStorage !== 'undefined' ? readStorageSnapshot(sessionStorage) : null;
      window.parent.postMessage({
        type: 'preview-storage-sync',
        port: PORT,
        local: localSnapshot,
        session: sessionSnapshot,
        cookies: readCookiesSnapshot()
      }, '*');
    } catch (e) {}
  }

  function scheduleStorageSync() {
    if (storageSyncTimeout) clearTimeout(storageSyncTimeout);
    storageSyncTimeout = setTimeout(sendStorageSync, 200);
  }

  function hookStorage(storage) {
    try {
      var originalSetItem = storage.setItem;
      var originalRemoveItem = storage.removeItem;
      var originalClear = storage.clear;

      storage.setItem = function() {
        var result = originalSetItem.apply(this, arguments);
        scheduleStorageSync();
        return result;
      };
      storage.removeItem = function() {
        var result = originalRemoveItem.apply(this, arguments);
        scheduleStorageSync();
        return result;
      };
      storage.clear = function() {
        var result = originalClear.apply(this, arguments);
        scheduleStorageSync();
        return result;
      };
    } catch (e) {}
  }

  try {
    if (typeof window !== 'undefined') {
      // Keep preview behavior aligned with native browser storage semantics:
      // report snapshots for DevTools, but do not rehydrate storage from parent.
      sendStorageSync();

      if (typeof localStorage !== 'undefined') {
        hookStorage(localStorage);
      }
      if (typeof sessionStorage !== 'undefined') {
        hookStorage(sessionStorage);
      }

      window.addEventListener('pagehide', sendStorageSync);
      window.addEventListener('beforeunload', sendStorageSync);
    }
  } catch (e) {}

  function isLocalHost(hostname) {
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return true;
    return /^(192\\.168\\.|10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)/.test(hostname);
  }

  function stripQueryAndHash(urlValue) {
    var trimmed = urlValue;
    var hashIndex = trimmed.indexOf('#');
    if (hashIndex !== -1) {
      trimmed = trimmed.slice(0, hashIndex);
    }
    var queryIndex = trimmed.indexOf('?');
    if (queryIndex !== -1) {
      trimmed = trimmed.slice(0, queryIndex);
    }
    return trimmed;
  }

  function withPreviewBasePath(pathname) {
    if (!PREVIEW_BASE_PATH) return pathname;
    var pathOnly = stripQueryAndHash(pathname);
    if (pathOnly === PREVIEW_BASE_PATH || pathOnly.startsWith(PREVIEW_BASE_PATH + '/')) {
      return pathname;
    }
    return PREVIEW_BASE_PATH + pathname;
  }

  function isRootRelative(urlValue) {
    return urlValue.startsWith('/') && !urlValue.startsWith('//');
  }

  function rewritePreviewUrl(rawUrl) {
    try {
      var urlValue = rawUrl;
      if (typeof urlValue !== 'string') {
        try {
          urlValue = String(rawUrl);
        } catch (e) {
          return rawUrl;
        }
      }
      if (!urlValue) {
        return rawUrl;
      }
      if (urlValue.startsWith('/api/preview')) {
        return urlValue;
      }
      if (PREVIEW_BASE_PATH && isRootRelative(urlValue)) {
        return PREVIEW_ORIGIN + withPreviewBasePath(urlValue);
      }
      if (!/^(https?|wss?):/i.test(urlValue) && !urlValue.startsWith('//')) {
        return urlValue;
      }
      var parsed = new URL(urlValue, PREVIEW_ORIGIN);
      if (parsed.pathname && parsed.pathname.startsWith('/api/preview')) {
        return urlValue;
      }
      if (PREVIEW_BASE_PATH && parsed.origin === PREVIEW_ORIGIN) {
        var sameOriginPath = parsed.pathname || '/';
        if (sameOriginPath.startsWith('/api/preview')) {
          return urlValue;
        }
        return PREVIEW_ORIGIN + withPreviewBasePath(sameOriginPath) + parsed.search + parsed.hash;
      }
      var hostname = parsed.hostname.toLowerCase();
      if (!isLocalHost(hostname)) return urlValue;
      if (parsed.port && parsed.port !== String(PORT)) return urlValue;
      return PREVIEW_ORIGIN + withPreviewBasePath(parsed.pathname) + parsed.search + parsed.hash;
    } catch (e) {
      return rawUrl;
    }
  }

  function rewriteWebSocketUrl(rawUrl) {
    try {
      var rewritten = rewritePreviewUrl(rawUrl);
      var parsed = new URL(rewritten, PREVIEW_ORIGIN);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      return parsed.toString();
    } catch (e) {
      return rawUrl;
    }
  }

  // Send logs to code.{domain} for subdomains, or same-origin for path-based/localhost preview
  const MAIN_IS_LOCAL = MAIN_DOMAIN === 'localhost' || MAIN_DOMAIN === '127.0.0.1' || MAIN_DOMAIN === '0.0.0.0';
  const API_BASE = (PREVIEW_BASE_PATH || MAIN_IS_LOCAL)
    ? location.origin
    : location.protocol + '//code.' + MAIN_DOMAIN;
  const API_URL = API_BASE + '/api/preview/' + PORT + '/logs';
  const pendingLogs = [];
  let flushTimeout = null;

  // Send logs to backend (batched)
  function flushLogs() {
    if (pendingLogs.length === 0) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    try {
      navigator.sendBeacon(API_URL, new Blob([JSON.stringify({ logs: batch })], { type: 'application/json' }));
    } catch (e) {
      // Fallback to fetch
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch }),
        keepalive: true
      }).catch(() => {});
    }
  }

  function queueLog(entry) {
    pendingLogs.push(entry);
    // Also send to parent via postMessage for browser UI
    try {
      window.parent.postMessage({ ...entry, type: 'preview-' + entry.type }, '*');
    } catch {}
    // Debounce flush
    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushLogs, 100);
  }

  // Serialize console arguments
  function serialize(args) {
    return args.map(function(arg) {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      if (arg instanceof Error) return arg.stack || arg.message;
      try { return JSON.stringify(arg, null, 2); }
      catch (e) { return String(arg); }
    }).join(' ');
  }

  // Console capture
  var origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };

  ['log', 'warn', 'error', 'info', 'debug'].forEach(function(level) {
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      queueLog({
        type: 'console',
        level: level,
        message: serialize(args),
        timestamp: Date.now()
      });
      origConsole[level].apply(console, args);
    };
  });

  // Error capture
  window.addEventListener('error', function(event) {
    queueLog({
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error ? event.error.stack : null,
      timestamp: Date.now()
    });
  });

  window.addEventListener('unhandledrejection', function(event) {
    var reason = event.reason;
    var message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    queueLog({
      type: 'error',
      message: 'Unhandled Promise Rejection: ' + message,
      stack: reason && reason.stack ? reason.stack : null,
      timestamp: Date.now()
    });
  });

  // Max body size for logging (50KB)
  var MAX_BODY_SIZE = 50 * 1024;

  function truncateBody(body) {
    if (!body || body.length <= MAX_BODY_SIZE) return body;
    return body.slice(0, MAX_BODY_SIZE) + '\\\\n... [truncated at 50KB]';
  }

  function headersToObject(headers) {
    var obj = {};
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach(function(value, key) { obj[key] = value; });
    } else if (headers && typeof headers === 'object') {
      Object.keys(headers).forEach(function(key) { obj[key] = headers[key]; });
    }
    return obj;
  }

  // Network capture - fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input.url || String(input));
    var method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    var startTime = Date.now();
    var rewrittenUrl = rewritePreviewUrl(url);
    if (rewrittenUrl !== url) {
      url = rewrittenUrl;
      if (typeof input === 'string') {
        input = rewrittenUrl;
      } else if (typeof URL !== 'undefined' && input instanceof URL) {
        input = rewrittenUrl;
      } else if (input && input instanceof Request) {
        input = new Request(rewrittenUrl, input);
      }
    }

    // Capture request headers
    var requestHeaders = {};
    if (init && init.headers) {
      requestHeaders = headersToObject(init.headers);
    } else if (typeof input === 'object' && input.headers) {
      requestHeaders = headersToObject(input.headers);
    }

    // Capture request body
    var requestBody = null;
    if (init && init.body) {
      if (typeof init.body === 'string') {
        requestBody = truncateBody(init.body);
      } else if (init.body instanceof FormData) {
        requestBody = '[FormData]';
      } else if (init.body instanceof Blob) {
        requestBody = '[Blob: ' + ((init.body.size || 0).toLocaleString()) + ' bytes]';
      }
    }

    return origFetch.call(this, input, init).then(function(response) {
      var duration = Date.now() - startTime;

      // Capture response headers
      var responseHeaders = headersToObject(response.headers);
      var contentType = response.headers.get('content-type') || '';

      var entry = {
        type: 'network',
        method: method,
        url: url,
        status: response.status,
        statusText: response.statusText,
        duration: duration,
        timestamp: startTime,
        requestHeaders: requestHeaders,
        responseHeaders: responseHeaders,
        requestBody: requestBody
      };

      // Capture response body for text-based responses
      if (contentType.includes('json') || contentType.includes('text') ||
          contentType.includes('xml') || contentType.includes('javascript')) {
        response.clone().text().then(function(text) {
          entry.responseBody = truncateBody(text);
          queueLog(entry);
        }).catch(function() {
          queueLog(entry);
        });
      } else {
        queueLog(entry);
      }

      return response;
    }).catch(function(err) {
      queueLog({
        type: 'network',
        method: method,
        url: url,
        error: err.message,
        duration: Date.now() - startTime,
        timestamp: startTime,
        requestHeaders: requestHeaders,
        requestBody: requestBody
      });
      throw err;
    });
  };

  // EventSource rewrite for localhost/dev URLs (SSE streams)
  var OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    window.EventSource = function(url, options) {
      var rewrittenUrl = rewritePreviewUrl(url);
      if (options !== undefined) {
        return new OrigEventSource(rewrittenUrl, options);
      }
      return new OrigEventSource(rewrittenUrl);
    };
    for (var esKey in OrigEventSource) {
      window.EventSource[esKey] = OrigEventSource[esKey];
    }
    window.EventSource.prototype = OrigEventSource.prototype;
  }

  // sendBeacon rewrite for localhost/dev URLs
  if (navigator && typeof navigator.sendBeacon === 'function') {
    try {
      var origSendBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data) {
        return origSendBeacon(rewritePreviewUrl(url), data);
      };
    } catch (e) {}
  }

  // WebSocket rewrite for local dev URLs (HMR, live reload, etc.)
  var OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    window.WebSocket = function(url, protocols) {
      var rewrittenUrl = rewriteWebSocketUrl(url);
      if (protocols !== undefined) {
        return new OrigWebSocket(rewrittenUrl, protocols);
      }
      return new OrigWebSocket(rewrittenUrl);
    };
    for (var key in OrigWebSocket) {
      window.WebSocket[key] = OrigWebSocket[key];
    }
    window.WebSocket.prototype = OrigWebSocket.prototype;
  }

  // Network capture - XMLHttpRequest
  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;
  var XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._debugMethod = method;
    var rewrittenUrl = rewritePreviewUrl(url);
    this._debugUrl = rewrittenUrl;
    this._debugHeaders = {};
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrittenUrl;
    return XHROpen.apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._debugHeaders) {
      this._debugHeaders[name] = value;
    }
    return XHRSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    var startTime = Date.now();
    var requestBody = null;

    if (body) {
      if (typeof body === 'string') {
        requestBody = truncateBody(body);
      } else if (body instanceof FormData) {
        requestBody = '[FormData]';
      } else if (body instanceof Blob) {
        requestBody = '[Blob: ' + ((body.size || 0).toLocaleString()) + ' bytes]';
      }
    }

    xhr.addEventListener('loadend', function() {
      var responseHeaders = {};
      try {
        var headerStr = xhr.getAllResponseHeaders();
        if (headerStr) {
          headerStr.split('\\\\r\\\\n').forEach(function(line) {
            var parts = line.split(': ');
            if (parts.length === 2) {
              responseHeaders[parts[0].toLowerCase()] = parts[1];
            }
          });
        }
      } catch (e) {}

      var contentType = xhr.getResponseHeader('content-type') || '';
      var entry = {
        type: 'network',
        method: xhr._debugMethod || 'GET',
        url: xhr._debugUrl || '',
        status: xhr.status,
        statusText: xhr.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
        requestHeaders: xhr._debugHeaders || {},
        responseHeaders: responseHeaders,
        requestBody: requestBody
      };

      // Capture response body for text-based responses
      if (contentType.includes('json') || contentType.includes('text') ||
          contentType.includes('xml') || contentType.includes('javascript')) {
        try {
          entry.responseBody = truncateBody(xhr.responseText || '');
        } catch (e) {}
      }

      queueLog(entry);
    });

    return XHRSend.apply(this, arguments);
  };

  // DOM Snapshot capture
  window.__captureDOM = function() {
    var html = document.documentElement.outerHTML;
    queueLog({
      type: 'dom',
      html: truncateBody(html),
      url: location.href,
      timestamp: Date.now()
    });
    return html.length;
  };

  // Storage Inspector
  function captureStorage() {
    var localStorage_data = {};
    var sessionStorage_data = {};
    var cookies_data = {};

    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        localStorage_data[key] = truncateBody(localStorage.getItem(key) || '');
      }
    } catch (e) {}

    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var key = sessionStorage.key(i);
        sessionStorage_data[key] = truncateBody(sessionStorage.getItem(key) || '');
      }
    } catch (e) {}

    try {
      var cookieString = document.cookie || '';
      if (cookieString) {
        cookieString.split(';').forEach(function(part) {
          var idx = part.indexOf('=');
          if (idx <= 0) return;
          var cookieKey = part.slice(0, idx).trim();
          var cookieValue = part.slice(idx + 1).trim();
          if (cookieKey) {
            try {
              cookies_data[cookieKey] = truncateBody(decodeURIComponent(cookieValue));
            } catch (e) {
              cookies_data[cookieKey] = truncateBody(cookieValue);
            }
          }
        });
      }
    } catch (e) {}

    queueLog({
      type: 'storage',
      localStorage: localStorage_data,
      sessionStorage: sessionStorage_data,
      cookies: cookies_data,
      timestamp: Date.now()
    });
  }

  window.__captureStorage = captureStorage;

  function serializeEvaluationValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return value.toString();
    try {
      return JSON.stringify(value, null, 2);
    } catch (e) {
      try {
        return String(value);
      } catch (stringifyError) {
        return '[Unserializable value]';
      }
    }
  }

  function sendStorageResult(payload, success, errorMessage) {
    try {
      window.parent.postMessage({
        type: 'preview-storage-result',
        requestId: payload.requestId || null,
        port: PORT,
        storageType: payload.storageType || payload.type || null,
        operation: payload.operation || null,
        key: payload.key || null,
        success: success,
        error: errorMessage || null,
        timestamp: Date.now()
      }, '*');
    } catch (e) {}
  }

  function applyStorageOperation(payload) {
    var storageType = payload.storageType || payload.type;
    var operation = payload.operation;
    var key = payload.key;
    var value = payload.value;
    var entries = payload.entries;

    try {
      if (storageType === 'localStorage' || storageType === 'sessionStorage') {
        var storage = storageType === 'sessionStorage' ? sessionStorage : localStorage;
        if (operation === 'set') {
          if (!key) throw new Error('Missing key for set operation');
          storage.setItem(String(key), value === undefined ? '' : String(value));
        } else if (operation === 'remove') {
          if (!key) throw new Error('Missing key for remove operation');
          storage.removeItem(String(key));
        } else if (operation === 'clear') {
          storage.clear();
        } else if (operation === 'import') {
          if (!entries || typeof entries !== 'object') throw new Error('Missing entries for import operation');
          Object.keys(entries).forEach(function(entryKey) {
            storage.setItem(String(entryKey), String(entries[entryKey]));
          });
        } else {
          throw new Error('Unsupported storage operation');
        }
      } else if (storageType === 'cookies') {
        if (operation === 'set') {
          if (!key) throw new Error('Missing key for set operation');
          document.cookie = String(key) + '=' + encodeURIComponent(value === undefined ? '' : String(value)) + '; path=/';
        } else if (operation === 'remove') {
          if (!key) throw new Error('Missing key for remove operation');
          document.cookie = String(key) + '=; Max-Age=0; path=/';
        } else if (operation === 'clear') {
          document.cookie.split(';').forEach(function(part) {
            var cookieName = part.split('=')[0];
            if (cookieName) {
              document.cookie = cookieName.trim() + '=; Max-Age=0; path=/';
            }
          });
        } else if (operation === 'import') {
          if (!entries || typeof entries !== 'object') throw new Error('Missing entries for import operation');
          Object.keys(entries).forEach(function(entryKey) {
            document.cookie = String(entryKey) + '=' + encodeURIComponent(String(entries[entryKey])) + '; path=/';
          });
        } else {
          throw new Error('Unsupported storage operation');
        }
      } else {
        throw new Error('Unsupported storage type');
      }
      sendStorageSync();
      captureStorage();
      sendStorageResult(payload, true, null);
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      sendStorageResult(payload, false, message);
    }
  }

  function evaluateInPreview(payload) {
    var expression = typeof payload.expression === 'string' ? payload.expression : '';
    var requestId = payload.requestId || null;

    function sendEvaluateResult(success, resultValue, valueType, errorMessage) {
      try {
        window.parent.postMessage({
          type: 'preview-evaluate-result',
          requestId: requestId,
          port: PORT,
          expression: expression,
          success: success,
          result: resultValue,
          valueType: valueType,
          error: errorMessage || null,
          timestamp: Date.now()
        }, '*');
      } catch (e) {}
    }

    if (!expression) {
      sendEvaluateResult(false, null, null, 'Missing expression');
      return;
    }

    try {
      var value = (0, eval)(expression);
      if (value && typeof value.then === 'function') {
        value.then(function(resolvedValue) {
          sendEvaluateResult(true, serializeEvaluationValue(resolvedValue), typeof resolvedValue, null);
        }).catch(function(error) {
          var message = error && error.message ? error.message : String(error);
          sendEvaluateResult(false, null, null, message);
        });
        return;
      }
      sendEvaluateResult(true, serializeEvaluationValue(value), typeof value, null);
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      sendEvaluateResult(false, null, null, message);
    }
  }

  // Capture storage on load and changes
  window.addEventListener('load', function() {
    setTimeout(captureStorage, 1000);
  });

  window.addEventListener('storage', captureStorage);

  // Listen for commands from parent
  window.addEventListener('message', function(event) {
    if (event.source && event.source !== window.parent) return;
    var payload = event.data || {};
    if (payload.port && String(payload.port) !== String(PORT)) return;

    if (payload.type === 'preview-capture-dom') {
      window.__captureDOM();
    } else if (payload.type === 'preview-capture-storage') {
      window.__captureStorage();
    } else if (payload.type === 'preview-storage-operation') {
      applyStorageOperation(payload);
    } else if (payload.type === 'preview-evaluate') {
      evaluateInPreview(payload);
    }
  });

  // Flush on page unload
  window.addEventListener('beforeunload', flushLogs);
  window.addEventListener('pagehide', flushLogs);
})();
</script>
`;

// Performance monitoring script - captures Core Web Vitals and runtime metrics
const PERFORMANCE_MONITOR_SCRIPT = `
<script>
(function() {
  if (window.__performanceMonitorInjected) return;
  window.__performanceMonitorInjected = true;

  function getPreviewContext() {
    const hostMatch = location.hostname.match(/^preview-(\\d+)\\.(.+)$/i);
    if (hostMatch) {
      return { port: hostMatch[1], mainDomain: hostMatch[2], basePath: '' };
    }
    const rawPath = (window.__previewGetRawPathname && window.__previewGetRawPathname()) || location.pathname;
    const pathMatch = rawPath.match(/^\\/preview\\/(\\d+)(\\/|$)/);
    if (pathMatch) {
      return { port: pathMatch[1], mainDomain: location.host, basePath: '/preview/' + pathMatch[1] };
    }
    return null;
  }

  const ctx = getPreviewContext();
  if (!ctx) return;
  const PORT = ctx.port;
  const MAIN_DOMAIN = ctx.mainDomain;
  const PREVIEW_BASE_PATH = ctx.basePath;
  const MAIN_IS_LOCAL = MAIN_DOMAIN === 'localhost' || MAIN_DOMAIN === '127.0.0.1' || MAIN_DOMAIN === '0.0.0.0';
  const API_BASE = (PREVIEW_BASE_PATH || MAIN_IS_LOCAL)
    ? location.origin
    : location.protocol + '//code.' + MAIN_DOMAIN;
  const API_URL = API_BASE + '/api/preview/' + PORT + '/performance';

  const metricsBuffer = [];
  let flushTimer = null;

  function sendMetrics(metrics) {
    if (!metrics || metrics.length === 0) return;

    // Send to backend for storage
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metrics: metrics }),
      keepalive: true
    }).catch(function(err) {
      console.debug('[perf-monitor] Failed to send metrics:', err);
    });
  }

  function flushMetrics() {
    if (metricsBuffer.length === 0) return;
    const toSend = metricsBuffer.splice(0, metricsBuffer.length);
    sendMetrics(toSend);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function() {
      flushTimer = null;
      flushMetrics();
    }, 2000);
  }

  function trackMetric(type, data) {
    metricsBuffer.push({
      type: type,
      timestamp: Date.now(),
      data: data
    });
    scheduleFlush();
  }

  // Core Web Vitals - LCP (Largest Contentful Paint)
  try {
    const lcpObserver = new PerformanceObserver(function(list) {
      const entries = list.getEntries();
      const lastEntry = entries[entries.length - 1];
      trackMetric('coreWebVitals', {
        lcp: lastEntry.renderTime || lastEntry.loadTime,
        fid: null,
        cls: null
      });
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}

  // Core Web Vitals - FID (First Input Delay)
  try {
    const fidObserver = new PerformanceObserver(function(list) {
      const entries = list.getEntries();
      entries.forEach(function(entry) {
        trackMetric('coreWebVitals', {
          lcp: null,
          fid: entry.processingStart - entry.startTime,
          cls: null
        });
      });
    });
    fidObserver.observe({ type: 'first-input', buffered: true });
  } catch (e) {}

  // Core Web Vitals - CLS (Cumulative Layout Shift)
  try {
    let clsValue = 0;
    const clsObserver = new PerformanceObserver(function(list) {
      const entries = list.getEntries();
      entries.forEach(function(entry) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
        }
      });
      trackMetric('coreWebVitals', {
        lcp: null,
        fid: null,
        cls: clsValue
      });
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}

  // Load Metrics
  window.addEventListener('load', function() {
    setTimeout(function() {
      try {
        const navTiming = performance.getEntriesByType('navigation')[0];
        if (navTiming) {
          trackMetric('loadMetrics', {
            domContentLoaded: navTiming.domContentLoadedEventEnd - navTiming.domContentLoadedEventStart,
            fullPageLoad: navTiming.loadEventEnd - navTiming.loadEventStart,
            timeToInteractive: navTiming.domInteractive - navTiming.fetchStart
          });
        }
      } catch (e) {}
    }, 0);
  });

  // Runtime Performance - FPS and Memory
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let lastFPSReport = performance.now();

  function measureFPS() {
    const now = performance.now();
    frameCount++;

    // Report FPS every second
    if (now - lastFPSReport >= 1000) {
      const fps = frameCount * 1000 / (now - lastFPSReport);
      const data = { fps: fps, memory: null, longTasks: [] };

      // Add memory info if available
      if (performance.memory) {
        data.memory = {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        };
      }

      trackMetric('runtimeMetrics', data);
      frameCount = 0;
      lastFPSReport = now;
    }

    lastFrameTime = now;
    requestAnimationFrame(measureFPS);
  }

  // Start FPS monitoring
  requestAnimationFrame(measureFPS);

  // Long Tasks
  try {
    const longTaskObserver = new PerformanceObserver(function(list) {
      const longTasks = list.getEntries().map(function(entry) {
        return {
          startTime: entry.startTime,
          duration: entry.duration
        };
      });
      if (longTasks.length > 0) {
        trackMetric('runtimeMetrics', {
          fps: null,
          memory: null,
          longTasks: longTasks
        });
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch (e) {}

  // Flush metrics on page unload
  window.addEventListener('beforeunload', flushMetrics);
  window.addEventListener('pagehide', flushMetrics);
})();
</script>
`;

function getPreviewPort(host: string | undefined): number | null {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const match = hostname.match(PREVIEW_SUBDOMAIN_PATTERN);
  if (!match) return null;

  const portStr = match[1];
  // Pre-validate that string contains only digits to prevent parseInt edge cases
  if (!/^\d+$/.test(portStr)) return null;

  const port = parseInt(portStr, 10);
  // Validate port is a safe integer and within allowed range
  if (!Number.isSafeInteger(port) || Number.isNaN(port) || port < PREVIEW_PORT_RANGE.min || port > PREVIEW_PORT_RANGE.max) return null;
  if (port === APP_PORT) return null;
  return port;
}

function getPreviewPathMatch(url: string | undefined): { port: number; path: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    return null;
  }
  const match = parsed.pathname.match(PREVIEW_PATH_PATTERN);
  if (!match) return null;

  const portStr = match[1];
  // Pre-validate that string contains only digits to prevent parseInt edge cases
  if (!/^\d+$/.test(portStr)) return null;

  const port = parseInt(portStr, 10);
  // Validate port is a safe integer and within allowed range
  if (!Number.isSafeInteger(port) || Number.isNaN(port) || port < PREVIEW_PORT_RANGE.min || port > PREVIEW_PORT_RANGE.max) {
    return null;
  }
  if (port === APP_PORT) {
    return null;
  }
  const path = (match[2] || '/') + parsed.search + parsed.hash;
  return { port, path };
}

function getPreviewHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(':')[0];
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const proto = forwardedProto.split(',')[0]?.trim();
    if (proto === 'https') return true;
  }
  const cfVisitor = request.headers['cf-visitor'];
  if (typeof cfVisitor === 'string' && cfVisitor.includes('"scheme":"https"')) {
    return true;
  }
  return false;
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  const upgradeHeader = request.headers.upgrade;
  if (typeof upgradeHeader === 'string' && upgradeHeader.toLowerCase() === 'websocket') {
    return true;
  }
  const connectionHeader = request.headers.connection;
  if (typeof connectionHeader === 'string' && connectionHeader.toLowerCase().includes('upgrade')) {
    return true;
  }
  return false;
}

// RFC 6265 validation for cookie names and values
function isValidCookieName(name: string): boolean {
  // RFC 6265: token = 1*<any CHAR except CTLs or separators>
  // Allowed: !#$%&'*+-.0-9A-Z^_`a-z|~
  return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function isValidCookieValue(value: string): boolean {
  // RFC 6265: cookie-value = *cookie-octet / ( DQUOTE *cookie-octet DQUOTE )
  // cookie-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
  // Excludes control chars, space, ", comma, semicolon, backslash
  return /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value);
}

function mergeCookieHeaders(requestCookies: string, storedCookies: string): string {
  const merged = new Map<string, string>();

  for (const cookiePart of requestCookies.split(';')) {
    const trimmed = cookiePart.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Validate cookie name and value per RFC 6265
    if (!isValidCookieName(name)) {
      console.warn(`[Preview] Invalid cookie name rejected: ${name}`);
      continue;
    }
    if (!isValidCookieValue(value)) {
      console.warn(`[Preview] Invalid cookie value rejected for ${name}`);
      continue;
    }
    if (!merged.has(name)) {
      merged.set(name, value);
    }
  }

  for (const cookiePart of storedCookies.split(';')) {
    const trimmed = cookiePart.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (merged.has(name)) continue;
    const value = trimmed.slice(eqIndex + 1).trim();
    // Validate cookie name and value per RFC 6265
    if (!isValidCookieName(name)) {
      console.warn(`[Preview] Invalid cookie name rejected: ${name}`);
      continue;
    }
    if (!isValidCookieValue(value)) {
      console.warn(`[Preview] Invalid cookie value rejected for ${name}`);
      continue;
    }
    merged.set(name, value);
  }

  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function shouldSkipRewrite(urlValue: string, isPathPreview = false): boolean {
  if (
    urlValue.startsWith('http://') ||
    urlValue.startsWith('https://') ||
    urlValue.startsWith('//') ||
    urlValue.startsWith('data:') ||
    urlValue.includes('_cb=')
  ) {
    return true;
  }

  if (isPathPreview) {
    return false;
  }

  return (
    urlValue.startsWith('/_next/') ||
    urlValue.startsWith('/@vite/') ||
    urlValue.startsWith('/@react-refresh') ||
    urlValue.startsWith('/@fs/') ||
    urlValue.startsWith('/@id/') ||
    urlValue.startsWith('/node_modules/')
  );
}

function prefixPreviewBasePath(urlValue: string, previewBasePath: string): string {
  if (!previewBasePath) return urlValue;
  if (!urlValue.startsWith('/') || urlValue.startsWith('//')) return urlValue;
  if (
    urlValue === previewBasePath ||
    urlValue.startsWith(`${previewBasePath}/`) ||
    urlValue.startsWith(`${previewBasePath}?`) ||
    urlValue.startsWith(`${previewBasePath}#`)
  ) {
    return urlValue;
  }
  return `${previewBasePath}${urlValue}`;
}

function addCacheBuster(urlValue: string, cacheBuster: string): string {
  const pathOnly = urlValue.split('?')[0] || '';
  if (pathOnly.includes('/@') || pathOnly.includes('/node_modules/')) {
    return urlValue;
  }
  if (!pathOnly.startsWith('/') && !pathOnly.startsWith('./') && !pathOnly.startsWith('../') && !pathOnly.startsWith('http')) {
    return urlValue;
  }
  const separator = urlValue.includes('?') ? '&' : '?';
  return `${urlValue}${separator}_cb=${cacheBuster}`;
}

function rewriteCssText(
  css: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean }
): string {
  let rewritten = css;
  rewritten = rewritten.replace(
    /url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (match, quote, urlValue) => {
      const normalized = rewriteUrlValue ? rewriteUrlValue(urlValue) : { url: urlValue, skip: shouldSkipRewrite(urlValue) };
      if (normalized.skip) {
        return match;
      }
      return `url(${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote})`;
    }
  );

  rewritten = rewritten.replace(
    /@import\s+(["'])([^"']+)\1/gi,
    (match, quote, importUrl) => {
      const normalized = rewriteUrlValue ? rewriteUrlValue(importUrl) : { url: importUrl, skip: shouldSkipRewrite(importUrl) };
      if (normalized.skip) {
        return match;
      }
      return `@import ${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
    }
  );
  return rewritten;
}

function rewriteSrcset(
  srcset: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean }
): string {
  return srcset
    .split(',')
    .map((segment) => {
      const trimmed = segment.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const urlPart = parts.shift();
      if (!urlPart) {
        return trimmed;
      }
      const normalized = rewriteUrlValue ? rewriteUrlValue(urlPart) : { url: urlPart, skip: shouldSkipRewrite(urlPart) };
      if (normalized.skip) {
        return trimmed;
      }
      return [addCacheBuster(normalized.url, cacheBuster), ...parts].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

function rewriteJsImports(
  js: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean },
  shouldBust = true
): string {
  const rewriteSpecifier = (specifier: string) => {
    const normalized = rewriteUrlValue ? rewriteUrlValue(specifier) : { url: specifier, skip: shouldSkipRewrite(specifier) };
    if (normalized.skip) return specifier;
    return shouldBust ? addCacheBuster(normalized.url, cacheBuster) : normalized.url;
  };

  let rewritten = js.replace(
    /\b(import|export)\s+[^'"]*?from\s+(["'])([^"']+)\2/gi,
    (match, keyword, quote, specifier) => {
      return match.replace(specifier, rewriteSpecifier(specifier));
    }
  );

  rewritten = rewritten.replace(
    /\bimport\s+(["'])([^"']+)\1/gi,
    (match, quote, specifier) => {
      return `import ${quote}${rewriteSpecifier(specifier)}${quote}`;
    }
  );

  rewritten = rewritten.replace(
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/gi,
    (match, quote, specifier) => {
      return `import(${quote}${rewriteSpecifier(specifier)}${quote})`;
    }
  );

  return rewritten;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0' || lower === '::1') {
    return true;
  }
  return /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lower);
}

function rewriteLocalAbsoluteUrl(
  urlValue: string,
  port: number,
  previewOrigin: string,
  previewBasePath: string
): string {
  try {
    const parsed = new URL(urlValue);
    if (!isPrivateHostname(parsed.hostname)) {
      return urlValue;
    }
    const targetPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    if (Number.isNaN(targetPort) || targetPort !== port) {
      return urlValue;
    }
    const prefixedPath = prefixPreviewBasePath(parsed.pathname, previewBasePath);
    return `${previewOrigin}${prefixedPath}${parsed.search}${parsed.hash}`;
  } catch {
    return urlValue;
  }
}

function toVirtualPreviewPath(pathname: string, previewBasePath: string): string {
  if (!previewBasePath) {
    return pathname || '/';
  }
  if (pathname === previewBasePath) {
    return '/';
  }
  if (pathname.startsWith(`${previewBasePath}/`)) {
    const stripped = pathname.slice(previewBasePath.length);
    return stripped.length > 0 ? stripped : '/';
  }
  return pathname || '/';
}

function rewriteForwardedOriginHeader(
  value: string,
  port: number,
  previewOrigin: string
): string {
  if (value === 'null') {
    return value;
  }
  try {
    const parsed = new URL(value);
    if (parsed.origin !== previewOrigin) {
      return value;
    }
    return `http://localhost:${port}`;
  } catch {
    return value;
  }
}

function rewriteForwardedRefererHeader(
  value: string,
  port: number,
  previewOrigin: string,
  previewBasePath: string
): string {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== previewOrigin) {
      return value;
    }
    const virtualPath = toVirtualPreviewPath(parsed.pathname, previewBasePath);
    return `http://localhost:${port}${virtualPath}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function getWebSocketProtocols(request: FastifyRequest): string[] | undefined {
  const protocolHeader = request.headers['sec-websocket-protocol'];
  if (typeof protocolHeader !== 'string') return undefined;
  const protocols = protocolHeader
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return protocols.length > 0 ? protocols : undefined;
}

function buildWebSocketForwardHeaders(request: FastifyRequest, port: number, previewHost: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!WS_SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      headers[key] = value;
    }
  }

  headers['host'] = `localhost:${port}`;
  headers['x-forwarded-host'] = previewHost;
  const forwardedProto = isSecureRequest(request) ? 'https' : 'http';
  headers['x-forwarded-proto'] = forwardedProto;
  headers['x-forwarded-port'] = forwardedProto === 'https'
    ? '443'
    : (typeof request.headers.host === 'string' && request.headers.host.includes(':')
      ? request.headers.host.split(':')[1]
      : '80');
  headers['x-forwarded-for'] = request.ip || '127.0.0.1';

  return headers;
}

function openWebSocket(targetUrl: string, request: FastifyRequest, forwardHeaders: Record<string, string>): WebSocket {
  const protocols = getWebSocketProtocols(request);
  if (protocols) {
    return new WebSocket(targetUrl, protocols, { headers: forwardHeaders });
  }
  return new WebSocket(targetUrl, { headers: forwardHeaders });
}

function proxyWebSocketConnection(
  socket: WebSocket,
  request: FastifyRequest,
  port: number,
  targetPath: string,
  previewHost: string
): void {
  const forwardHeaders = buildWebSocketForwardHeaders(request, port, previewHost);
  const socketProtocols = getWebSocketProtocols(request);
  let upstreamWs: WebSocket | null = null;
  let connected = false;
  let upstreamClosed = false;
  let connectIndex = 0;

  // Whitelist HMR/dev tool patterns to avoid logging noise
  const isDevToolWs =
    targetPath.includes('/_next/webpack-hmr') ||
    targetPath.includes('/@vite/') ||
    targetPath.includes('/__webpack_hmr') ||
    targetPath.includes('/_hmr') ||
    targetPath.startsWith('/api/preview/');

  const connectionId = !isDevToolWs
    ? logWebSocketConnection(port, {
      url: targetPath,
      status: 'connecting',
      protocols: socketProtocols
    })
    : null;

  const closeBoth = (code: number, reason: string) => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
    if (upstreamWs && (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING)) {
      upstreamWs.close();
    }
  };

  socket.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data, { binary: isBinary });

      // Log sent messages (only non-dev tools)
      if (!isDevToolWs && connectionId) {
        const size = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
        const dataStr = isBinary ? `<Buffer ${size} bytes>` : String(data);
        logWebSocketMessage(port, {
          connectionId,
          direction: 'sent',
          format: isBinary ? 'binary' : 'text',
          size,
          data: dataStr
        });
      }
    }
  });

  const connectToUpstream = (host: string) => {
    const targetUrl = `ws://${formatHostForUrl(host)}:${port}${targetPath}`;
    const targetWs = openWebSocket(targetUrl, request, forwardHeaders);
    upstreamWs = targetWs;

    targetWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data, { binary: isBinary });

        // Log received messages (only non-dev tools)
        if (!isDevToolWs && connectionId) {
          const size = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
          const dataStr = isBinary ? `<Buffer ${size} bytes>` : String(data);
          logWebSocketMessage(port, {
            connectionId,
            direction: 'received',
            format: isBinary ? 'binary' : 'text',
            size,
            data: dataStr
          });
        }
      }
    });

    targetWs.on('open', () => {
      connected = true;
      // Update connection status
      if (!isDevToolWs && connectionId) {
        logWebSocketConnection(port, {
          id: connectionId,
          url: targetPath,
          status: 'connected',
          protocols: socketProtocols
        });
      }
    });

    targetWs.on('error', (error: Error) => {
      const message = error.message;
      if (!connected && shouldRetryProxyError(message) && connectIndex < PREVIEW_PROXY_HOSTS.length) {
        targetWs.close();
        connectToUpstream(PREVIEW_PROXY_HOSTS[connectIndex++]);
        return;
      }

      console.error(`Preview WS proxy error for port ${port}:`, message);

      // Log error
      if (!isDevToolWs && connectionId) {
        logWebSocketConnection(port, {
          id: connectionId,
          url: targetPath,
          status: 'error',
          error: message
        });
      }

      closeBoth(1011, 'Preview WebSocket upstream error');
    });

    targetWs.on('close', (code: number, reasonBuffer: Buffer) => {
      upstreamClosed = true;
      // Log closure
      if (!isDevToolWs && connectionId) {
        logWebSocketConnection(port, {
          id: connectionId,
          url: targetPath,
          status: 'closed',
          closeCode: Number.isFinite(code) ? code : undefined,
          closeReason: reasonBuffer?.toString() || undefined
        });
      }

      if (connected && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Preview WebSocket upstream closed');
      }
    });
  };

  if (PREVIEW_PROXY_HOSTS.length === 0) {
    closeBoth(1011, 'Preview WebSocket upstream hosts missing');
    return;
  }
  connectToUpstream(PREVIEW_PROXY_HOSTS[connectIndex++]);

  socket.on('close', (code: number, reasonBuffer: Buffer) => {
    if (!isDevToolWs && connectionId && !upstreamClosed) {
      logWebSocketConnection(port, {
        id: connectionId,
        url: targetPath,
        status: 'closed',
        closeCode: Number.isFinite(code) ? code : undefined,
        closeReason: reasonBuffer?.toString() || undefined
      });
    }
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
  });

  socket.on('error', () => {
    if (!isDevToolWs && connectionId) {
      logWebSocketConnection(port, {
        id: connectionId,
        url: targetPath,
        status: 'error',
        error: 'Preview WebSocket client socket error'
      });
    }
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
  });
}

export async function registerPreviewSubdomainRoutes(app: FastifyInstance): Promise<void> {
  // WebSocket proxy for path-based preview (local dev /preview/:port/*)
  app.get('/preview/:port/*', { websocket: true }, (socket, request) => {
    const match = getPreviewPathMatch(request.url);
    if (!match) {
      socket.close(1008, 'Preview port not found');
      return;
    }
    const previewHost = getPreviewHost(request.headers.host) || 'localhost';
    proxyWebSocketConnection(socket, request, match.port, match.path, previewHost);
  });

  // WebSocket proxy for preview subdomains (HMR, dev tooling, etc.)
  app.get('/*', { websocket: true, constraints: { host: getPreviewHostConstraint() } }, (socket, request) => {
    const port = getPreviewPort(request.headers.host);
    if (!port) {
      socket.close(1008, 'Preview port not found');
      return;
    }

    const previewHost = getPreviewHost(request.headers.host) || `preview-${port}.${PREVIEW_SUBDOMAIN_BASE}`;
    proxyWebSocketConnection(socket, request, port, request.url, previewHost);
  });

  // Handle all HTTP requests on preview subdomains
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Note: We no longer skip /api/ routes here because preview subdomains need to proxy
    // ALL requests (including /api/*) to the target dev server. The check for whether
    // this is a preview request happens below - if it's not a preview subdomain, the
    // hook returns early and lets Terminal V4's own routes handle it.

    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedHostValue = Array.isArray(forwardedHost)
      ? forwardedHost[0]
      : forwardedHost;
    const rawHost =
      (typeof forwardedHostValue === 'string' ? forwardedHostValue.split(',')[0].trim() : undefined) ||
      (typeof request.headers[':authority'] === 'string' ? request.headers[':authority'] : undefined) ||
      request.headers.host;
    let port = getPreviewPort(rawHost);
    let previewHost = port ? getPreviewHost(rawHost) : null;
    let previewBasePath = '';
    let requestPath = request.url;
    let isPathPreview = false;
    let originHost: string | undefined;
    const origin = request.headers.origin;

    const pathMatch = !port ? getPreviewPathMatch(request.url) : null;
    if (pathMatch) {
      port = pathMatch.port;
      requestPath = pathMatch.path;
      previewBasePath = `/preview/${port}`;
      previewHost = getPreviewHost(rawHost) || request.headers.host?.split(':')[0] || null;
      isPathPreview = true;
    }

    if (!port && typeof origin === 'string') {
      try {
        originHost = new URL(origin).host;
        port = getPreviewPort(originHost);
        if (port) {
          previewHost = getPreviewHost(originHost);
        }
      } catch {
        // Ignore invalid Origin values
      }
    }
    if (!port) return; // Not a preview request, continue to other routes
    if (!previewHost) {
      previewHost = getPreviewHost(rawHost) || getPreviewHost(originHost) || request.headers.host?.split(':')[0] || null;
    }
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : '';
    const resolvedOriginHost = rawHost || hostHeader || previewHost || 'localhost';
    const previewOrigin = isPathPreview
      ? `${isSecureRequest(request) ? 'https' : 'http'}://${resolvedOriginHost}`
      : `${isSecureRequest(request) ? 'https' : 'http'}://${previewHost || `preview-${port}.${PREVIEW_SUBDOMAIN_BASE}`}`;

    if (isWebSocketUpgrade(request)) {
      return;
    }

    // Store port for WebSocket handler
    (request as any).previewPort = port;

    // Handle CORS preflight without proxying upstream
    if (request.method === 'OPTIONS') {
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
      }
      reply.header('Access-Control-Allow-Credentials', 'true');
      const reqMethods = request.headers['access-control-request-method'];
      reply.header(
        'Access-Control-Allow-Methods',
        typeof reqMethods === 'string'
          ? reqMethods
          : 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );
      const reqHeaders = request.headers['access-control-request-headers'];
      reply.header(
        'Access-Control-Allow-Headers',
        typeof reqHeaders === 'string'
          ? reqHeaders
          : 'authorization, content-type, x-csrftoken, x-csrf-token'
      );
      reply.code(204).send();
      return reply;
    }

    // Intercept /__clear_session__ to expire browser cookies for this preview subdomain
    if (requestPath === '/__clear_session__') {
      const deletionHeaders: string[] = [];
      const seen = new Set<string>();

      // Parse cookie names from the browser's request header — the browser tells
      // us exactly which cookies it has, regardless of server-side store state.
      const browserCookieHeader = request.headers.cookie;
      if (typeof browserCookieHeader === 'string') {
        for (const pair of browserCookieHeader.split(';')) {
          const name = pair.split('=')[0]?.trim();
          if (name && !seen.has(name)) {
            seen.add(name);
            deletionHeaders.push(`${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
            // Also try with the preview path prefix for path-based preview
            if (isPathPreview) {
              deletionHeaders.push(`${name}=; Path=/preview/${port}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
            }
          }
        }
      }

      // Also include cookies from server-side store
      for (const { name, path } of getCookieNamesForDeletion(port)) {
        const key = `${name}:${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          deletionHeaders.push(`${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        }
      }

      // Clear the server-side store
      clearCookies(port);

      // Set deletion cookies on the response
      if (deletionHeaders.length > 0) {
        reply.header('Set-Cookie', deletionHeaders);
      }

      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      // Include JavaScript to clear non-HttpOnly cookies via document.cookie
      reply.code(200).send(`<!DOCTYPE html><html><body><p>Session cleared</p><script>
document.cookie.split(';').forEach(function(c){
  var name=c.split('=')[0].trim();
  if(name){
    document.cookie=name+'=;Max-Age=0;Path=/';
    document.cookie=name+'=;Max-Age=0;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
});
</script></body></html>`);
      return reply;
    }

    try {
      // Build headers to forward
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (!SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }
      // Set correct host for the target server
      forwardHeaders['host'] = `localhost:${port}`;

      // Normalize forwarded metadata to the upstream app origin for compatibility.
      // Many frameworks use these headers for CSRF and host validation, so keeping
      // them aligned with Host/Origin/Referer avoids preview-only auth mismatches.
      forwardHeaders['x-forwarded-host'] = `localhost:${port}`;
      forwardHeaders['x-forwarded-proto'] = 'http';
      forwardHeaders['x-forwarded-port'] = String(port);
      forwardHeaders['x-forwarded-for'] = request.ip || '127.0.0.1';

      // Normalize request metadata to the app's virtual origin so upstream
      // CSRF/origin checks behave like direct localhost browser access.
      const originHeader = forwardHeaders['origin'];
      if (typeof originHeader === 'string') {
        forwardHeaders['origin'] = rewriteForwardedOriginHeader(originHeader, port, previewOrigin);
      }
      const refererHeader = forwardHeaders['referer'];
      if (typeof refererHeader === 'string') {
        forwardHeaders['referer'] = rewriteForwardedRefererHeader(
          refererHeader,
          port,
          previewOrigin,
          previewBasePath
        );
      }

      // Inject server-side cookie jar for subdomain preview only.
      // Path-based preview already has first-party browser cookie behavior, and
      // merging persisted server cookies there can resurrect stale auth sessions.
      if (!isPathPreview) {
        const cookiePath = new URL(requestPath, `http://localhost:${port}`).pathname;
        const storedCookies = getCookieHeader(port, cookiePath);
        if (storedCookies) {
          // Merge with any cookies from the request (prefer browser cookies)
          const existingCookies = forwardHeaders['cookie'] || '';
          forwardHeaders['cookie'] = existingCookies
            ? mergeCookieHeaders(existingCookies, storedCookies)
            : storedCookies;
        }
      }

      // Buffer request body for non-GET requests (onRequest runs before body parsing)
      let body: Buffer | undefined = undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request.raw) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (chunks.length > 0) {
            body = Buffer.concat(chunks);
            forwardHeaders['content-length'] = String(body.length);
          } else {
            delete forwardHeaders['content-length'];
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Preview] Failed to buffer request body for ${request.method} ${request.url}:`, message);
          reply.code(400).send({
            error: 'Invalid request body',
            message: 'Failed to read request body'
          });
          return reply;
        }
      } else {
        delete forwardHeaders['content-length'];
      }

      // Make proxied request with timing
      const startTime = Date.now();
      let responseData = await fetchWithHostFallback(port, requestPath, {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual'
      });
      let response = responseData.response;

      // Follow internal redirects when app redirects to its own base path (e.g., /preview/8080/)
      // This prevents redirect loops when apps are configured with a base path matching the preview path
      const MAX_INTERNAL_REDIRECTS = 5;
      let redirectCount = 0;
      while (
        response.status >= 300 &&
        response.status < 400 &&
        redirectCount < MAX_INTERNAL_REDIRECTS
      ) {
        const redirectLocation = response.headers.get('location');
        if (!redirectLocation) break;

        // Check if redirect matches /preview/{port}/... pattern for the same port
        const internalRedirectMatch = redirectLocation.match(/^\/preview\/(\d+)(\/.*)?$/);
        if (!internalRedirectMatch) break;

        const redirectPort = parseInt(internalRedirectMatch[1], 10);
        if (redirectPort !== port) break;

        // Follow this redirect internally - use full redirect location since app expects it

        // Consume the response body to avoid memory leaks
        try { await response.arrayBuffer(); } catch {}

        // Build headers for redirect (exclude content-length since it's a GET)
        const redirectHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(forwardHeaders)) {
          if (key.toLowerCase() !== 'content-length') {
            redirectHeaders[key] = value;
          }
        }

        responseData = await fetchWithHostFallback(port, redirectLocation, {
          method: 'GET', // Redirects are always GET
          headers: redirectHeaders,
          redirect: 'manual'
        });
        response = responseData.response;
        redirectCount++;
      }

      // Fallback: if 404 and we stripped a prefix, try with the full path
      // This handles apps configured with base path matching /preview/{port}/
      if (response.status === 404 && previewBasePath && requestPath !== request.url) {
        try { await response.arrayBuffer(); } catch {} // Consume body
        responseData = await fetchWithHostFallback(port, `${previewBasePath}${requestPath}`, {
          method: request.method,
          headers: forwardHeaders,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? body : undefined,
          redirect: 'manual'
        });
        response = responseData.response;
      }

      const duration = Date.now() - startTime;

      // Set response status
      reply.code(response.status);

      // Get response info for logging
      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      let responseSize: number = contentLength ? parseInt(contentLength, 10) : 0;
      const requestBodySize = body ? body.byteLength : null;

      // Forward response headers
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'transfer-encoding' || lowerKey === 'connection') continue;
        if (lowerKey === 'content-length') continue;
        // Skip content-encoding since fetch() automatically decompresses the response
        if (lowerKey === 'content-encoding') continue;

        // Remove X-Frame-Options to allow iframe embedding
        if (lowerKey === 'x-frame-options') continue;
        if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') continue;

        // Skip Set-Cookie here - handle separately below
        if (lowerKey === 'set-cookie') continue;

        reply.header(key, value);
      }

      // Allow cross-origin access when preview is embedded elsewhere
      const origin = request.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }

      // Handle Set-Cookie headers specially - entries() doesn't handle multiple cookies correctly
      const setCookieHeaders =
        typeof (response.headers as any).getSetCookie === 'function'
          ? (response.headers as any).getSetCookie()
          : (response.headers as any).raw?.()['set-cookie'] ??
            (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
      if (setCookieHeaders.length > 0) {
        const secureRequest = isSecureRequest(request);
        let rewrittenCookies = setCookieHeaders;
        if (previewHost) {
          const rewriteOptions = {
            previewHost,
            isSecureRequest: secureRequest
          } as Parameters<typeof rewriteSetCookieHeaders>[1];

          if (PREVIEW_COOKIE_POLICY === 'compat-rewrite') {
            rewriteOptions.defaultSameSite = secureRequest ? 'none' : undefined;
          } else if (PREVIEW_COOKIE_POLICY === 'force-none') {
            rewriteOptions.defaultSameSite = secureRequest ? 'none' : undefined;
            rewriteOptions.forceSameSite = secureRequest ? 'none' : undefined;
          }

          rewrittenCookies = rewriteSetCookieHeaders(setCookieHeaders, rewriteOptions);
        }
        // Store cookies server-side for both preview modes.
        // For subdomain preview, stored cookies are injected into upstream requests.
        // For path-based preview, cookies are only stored so the clear-session
        // endpoint knows which cookie names to expire (no injection occurs).
        storeCookies(port, rewrittenCookies);
        // Forward rewritten cookies to browser for client-side access
        reply.header('set-cookie', rewrittenCookies);
      }

      // Allow iframe embedding
      reply.header('X-Frame-Options', 'ALLOWALL');

      // Prevent caching to ensure refresh always fetches fresh content
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');

      // Check if inspect mode was requested (for preserving on redirects)
      let inspectModeRequested = false;
      try {
        const reqUrl = new URL(requestPath, `http://localhost:${port}`);
        inspectModeRequested = reqUrl.searchParams.get('__inspect') === '1';
      } catch {
        // Ignore parse errors
      }

      // Handle redirects - rewrite Location header and preserve __inspect param
      const location = response.headers.get('location');
      if (location) {
        let finalLocation = location;
        const rewrittenLocation = rewriteLocalAbsoluteUrl(location, port, previewOrigin, previewBasePath);
        if (rewrittenLocation !== location) {
          finalLocation = rewrittenLocation;
        } else if (previewBasePath) {
          try {
            const resolved = new URL(location, `${previewOrigin}${previewBasePath}${requestPath}`);
            if (resolved.origin === previewOrigin) {
              const normalizedPath = `${resolved.pathname}${resolved.search}${resolved.hash}`;
              finalLocation = prefixPreviewBasePath(normalizedPath, previewBasePath);
            }
          } catch {
            // Keep original location
          }
        }
        // Preserve __inspect=1 on same-origin redirects to maintain inspect mode
        if (inspectModeRequested && !finalLocation.includes('__inspect=')) {
          try {
            // Only for relative URLs or same-origin
            if (finalLocation.startsWith('/') || finalLocation.startsWith(previewOrigin)) {
              const separator = finalLocation.includes('?') ? '&' : '?';
              finalLocation = `${finalLocation}${separator}__inspect=1`;
            }
          } catch {
            // Ignore errors, don't break redirect
          }
        }
        reply.header('location', finalLocation);
      }

      // Stream response body
      let responseBodyBuffer: Buffer | null = null;
      if (response.body) {
        // Extract cache-buster from request URL (inspect mode already extracted above)
        let cacheBuster: string;
        try {
          const url = new URL(requestPath, `http://localhost:${port}`);
          const cbParam = url.searchParams.get('_cb');
          // Validate cache buster is numeric to prevent XSS
          cacheBuster = (cbParam && /^\d+$/.test(cbParam)) ? cbParam : Date.now().toString();
        } catch {
          // If URL parsing fails, generate fresh cache buster
          cacheBuster = Date.now().toString();
        }
        // Use inspectModeRequested (extracted earlier for redirect handling)
        const inspectModeEnabled = inspectModeRequested;
        const contentType = response.headers.get('content-type') || '';
        const isHtml = contentType.includes('text/html');
        const isScriptPath = requestPath.startsWith('/@');
        const isJs = contentType.includes('javascript') || requestPath.endsWith('.js') || requestPath.endsWith('.mjs') || isScriptPath;
        const isCss = contentType.includes('text/css') || ((requestPath.endsWith('.css') || requestPath.includes('.css?')) && !isJs);
        const shouldRewrite = isHtml || isCss || (isJs && isPathPreview);
        // Avoid cache-busting JS imports to prevent duplicate module graphs (React #321).
        const shouldBustScripts = false;
        const rewriteUrlValue = (value: string) => {
          // Check skip BEFORE normalization to catch framework paths like /_next/
          if (shouldSkipRewrite(value, isPathPreview)) {
            return { url: value, skip: true };
          }
          let normalized = rewriteLocalAbsoluteUrl(value, port, previewOrigin, previewBasePath);
          normalized = prefixPreviewBasePath(normalized, previewBasePath);
          const isPreviewHost = normalized.startsWith(previewOrigin) ||
            (!!previewBasePath && (normalized === previewBasePath || normalized.startsWith(`${previewBasePath}/`)));
          if (!isPreviewHost && shouldSkipRewrite(normalized, isPathPreview)) {
            return { url: normalized, skip: true };
          }
          return { url: normalized, skip: false };
        };

        if (isJs && !contentType.includes('javascript')) {
          reply.header('content-type', 'text/javascript');
        }

        if (!shouldRewrite) {
          // For raw piping, we need to set headers on reply.raw since reply.header() won't apply
          const headers = reply.getHeaders();
          for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined) {
              reply.raw.setHeader(key, value as string | string[]);
            }
          }
          const nodeStream = Readable.fromWeb(response.body);
          nodeStream.pipe(reply.raw);
          await new Promise<void>((resolve, reject) => {
            nodeStream.on('end', resolve);
            nodeStream.on('error', reject);
            reply.raw.on('close', resolve);
          });
          responseSize = responseSize || 0;
          responseBodyBuffer = null;
          // Continue to logging after streaming completes.
        } else {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalSize = 0;
          let timeoutId: NodeJS.Timeout | null = null;

          try {
            // Set up timeout
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reader.cancel('Response read timeout');
                reject(new Error('Response read timeout exceeded'));
              }, RESPONSE_READ_TIMEOUT);
            });

            // Race between reading and timeout
            await Promise.race([
              (async () => {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;

                  totalSize += value.length;
                  if (totalSize > MAX_RESPONSE_SIZE) {
                    reader.cancel('Response too large');
                    throw new Error(`Response size exceeds ${MAX_RESPONSE_SIZE} bytes`);
                  }

                  chunks.push(value);
                }
              })(),
              timeoutPromise
            ]);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Preview] Response read error for ${request.url}:`, message);
            reply.code(502).send({
              error: 'Response read error',
              message: message.includes('timeout') ? 'Response read timeout' : 'Response too large'
            });
            return reply;
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }

          responseBodyBuffer = Buffer.concat(chunks);
          const body = responseBodyBuffer;

          if (isHtml) {
            let html = body.toString('utf-8');

          // Add cache-buster to src attributes (scripts, images, etc.)
          html = html.replace(
            /(<(?:script|img|source|video|audio|embed|track|iframe)[^>]*\s)src=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcUrl) => {
              const normalized = rewriteUrlValue(srcUrl);
              if (normalized.skip) {
                return match;
              }
              const isScriptTag = /^<script/i.test(prefix.trim());
              const rewritten = (!shouldBustScripts && isScriptTag)
                ? normalized.url
                : addCacheBuster(normalized.url, cacheBuster);
              return `${prefix}src=${quote}${rewritten}${quote}`;
            }
          );

          // Add cache-buster to srcset attributes
          html = html.replace(
            /(<(?:img|source)[^>]*\s)srcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}srcset=${quote}${rewritten}${quote}`;
            }
          );

          // Add cache-buster to imagesrcset attributes (e.g., link rel=preload)
          html = html.replace(
            /(<link[^>]*\s)imagesrcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}imagesrcset=${quote}${rewritten}${quote}`;
            }
          );

          // Add cache-buster to poster attributes
          html = html.replace(
            /(<video[^>]*\s)poster=(["'])([^"']+)\2/gi,
            (match, prefix, quote, posterUrl) => {
              const normalized = rewriteUrlValue(posterUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}poster=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );

          // Add cache-buster to href attributes (stylesheets, etc.)
          html = html.replace(
            /(<link[^>]*\s)href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, hrefUrl) => {
              const normalized = rewriteUrlValue(hrefUrl);
              if (normalized.skip) {
                return match;
              }
              const isModulePreload = /rel=(["'])modulepreload\1/i.test(match) ||
                (/rel=(["'])preload\1/i.test(match) && /as=(["'])script\1/i.test(match));
              const rewritten = (!shouldBustScripts && isModulePreload)
                ? normalized.url
                : addCacheBuster(normalized.url, cacheBuster);
              return `${prefix}href=${quote}${rewritten}${quote}`;
            }
          );

          // Rewrite navigation links to stay within preview origin
          html = html.replace(
            /(<a[^>]*\s)href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, hrefUrl) => {
              const normalized = rewriteUrlValue(hrefUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}href=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite form actions to stay within preview origin
          html = html.replace(
            /(<form[^>]*\s)action=(["'])([^"']+)\2/gi,
            (match, prefix, quote, actionUrl) => {
              const normalized = rewriteUrlValue(actionUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}action=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite meta refresh URLs
          html = html.replace(
            /<meta[^>]*http-equiv=(["'])refresh\1[^>]*>/gi,
            (match) => {
              const contentMatch = match.match(/content=(["'])([^"']+)\1/i);
              if (!contentMatch) return match;
              const quote = contentMatch[1];
              const contentValue = contentMatch[2];
              const urlMatch = contentValue.match(/url=([^;]+)$/i);
              if (!urlMatch) return match;
              const rawUrl = urlMatch[1].trim();
              const normalized = rewriteUrlValue(rawUrl);
              if (normalized.skip) return match;
              const updatedContent = contentValue.replace(urlMatch[1], normalized.url);
              return match.replace(contentMatch[0], `content=${quote}${updatedContent}${quote}`);
            }
          );

          // Rewrite common data-* URL attributes used by lazy loaders
          html = html.replace(
            /(\s)data-src=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataSrc) => {
              const normalized = rewriteUrlValue(dataSrc);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-src=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-poster=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataPoster) => {
              const normalized = rewriteUrlValue(dataPoster);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-poster=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-srcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}data-srcset=${quote}${rewritten}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataHref) => {
              const normalized = rewriteUrlValue(dataHref);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-href=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite inline style attributes with url() references
          html = html.replace(
            /style=(["'])([^"']+)\1/gi,
            (match, quote, styleValue) => {
              if (!styleValue.includes('url(') && !styleValue.includes('@import')) {
                return match;
              }
              return `style=${quote}${rewriteCssText(styleValue, cacheBuster, rewriteUrlValue)}${quote}`;
            }
          );

          // Rewrite <style> blocks
          html = html.replace(
            /<style([^>]*)>([\s\S]*?)<\/style>/gi,
            (match, attrs, cssText) => {
              const rewritten = rewriteCssText(cssText, cacheBuster, rewriteUrlValue);
              return `<style${attrs}>${rewritten}</style>`;
            }
          );

          // Rewrite inline module scripts (e.g., Vite react-refresh preamble)
          html = html.replace(
            /<script([^>]*type=(["'])module\2[^>]*)>([\s\S]*?)<\/script>/gi,
            (match, attrs, quote, scriptText) => {
              if (/\bsrc=/.test(attrs)) {
                return match;
              }
              if (!shouldBustScripts) {
                return match;
              }
              const rewritten = rewriteJsImports(scriptText, cacheBuster, rewriteUrlValue, shouldBustScripts);
              return `<script${attrs}>${rewritten}</script>`;
            }
          );

          const useLegacyPreviewFixes = isPathPreview || PREVIEW_REWRITE_SCOPE === 'legacy';
          const includePerformanceMonitor = useLegacyPreviewFixes || PREVIEW_REWRITE_SCOPE === 'hybrid';

          // Inject debug script and inspector script at start of <head> to run before app code
          // CSS fix for backdrop-filter in iframes - forces proper stacking context
          const backdropFixCSS = `<style>
/* Force stacking context on root elements */
html, body { isolation: isolate; }
/* Ensure elements with backdrop-filter have proper rendering context */
[style*="backdrop-filter"],
[style*="-webkit-backdrop-filter"],
[class*="backdrop"],
[class*="glass"],
[class*="blur"] {
  isolation: isolate !important;
  transform: translateZ(0) !important;
  -webkit-transform: translateZ(0) !important;
  backface-visibility: hidden !important;
  -webkit-backface-visibility: hidden !important;
  will-change: backdrop-filter, transform !important;
}
/* Force GPU layer for elements with blur in Tailwind */
.backdrop-blur, .backdrop-blur-sm, .backdrop-blur-md, .backdrop-blur-lg, .backdrop-blur-xl, .backdrop-blur-2xl, .backdrop-blur-3xl {
  isolation: isolate !important;
  transform: translateZ(0) !important;
  will-change: backdrop-filter !important;
}
</style>`;

          // CSS fix for animation libraries (Framer Motion, GSAP, AOS, ScrollReveal, WOW.js, etc.)
          // Scoped to html[data-preview-force-anim] to avoid breaking modals/dropdowns/tooltips
          // In iframe previews, animations may not trigger properly, leaving content invisible
          const animationFixCSS = `<script>document.documentElement.setAttribute('data-preview-force-anim','1');</script>
<style>
/* Animation library data attributes and classes */
html[data-preview-force-anim="1"] :is(
  [data-aos],
  .aos-init:not(.aos-animate),
  .gsap-hidden,
  [data-gsap],
  [data-sr-id],
  .wow,
  .reveal,
  [data-animate],
  [data-anim],
  [data-motion],
  [data-scroll],
  [data-locomotive]
) {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  filter: none !important;
}

/* Fallback: inline opacity blockers (Framer Motion, React Spring, etc.) */
html[data-preview-force-anim="1"] :is(
  [style*="opacity:0"],
  [style*="opacity: 0"],
  [style*="filter:opacity(0"],
  [style*="filter: opacity(0"]
) {
  opacity: 1 !important;
  filter: none !important;
}

/* Fallback: inline transform + opacity combos */
html[data-preview-force-anim="1"] :is(
  [style*="translate"],
  [style*="scale("],
  [style*="scale3d("],
  [style*="rotate("]
)[style*="opacity"] {
  transform: none !important;
}

/* Clip/mask hiding patterns */
html[data-preview-force-anim="1"] :is(
  [style*="clip-path"],
  [style*="clip:"],
  [style*="mask"]
) {
  clip-path: none !important;
  -webkit-clip-path: none !important;
  mask: none !important;
}

/* Height-based collapse animations */
html[data-preview-force-anim="1"] :is(
  [style*="max-height:0"],
  [style*="max-height: 0"],
  [style*="height:0"],
  [style*="height: 0"]
) {
  max-height: none !important;
  height: auto !important;
}
</style>`;
          // Only inject inspector script when explicitly requested via __inspect=1 parameter (lazy injection)
          const inspectorScriptTag = inspectModeEnabled ? '<script>' + INSPECTOR_SCRIPT + '</script>' : '';

          // For path-based preview, inject a script that rewrites client-side
          // fetch/XHR calls so absolute paths like /api/auth/signout get
          // routed through the preview proxy instead of hitting Terminal V4.
          const pathRewriteScript = isPathPreview && previewBasePath ? `<script>(function(){
var P="${previewBasePath}";
var _fetch=window.fetch;
window.fetch=function(u,o){
  if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(P+'/')&&!u.startsWith('/api/preview')&&!u.startsWith('/api/terminal')&&!u.startsWith('/api/auth')&&!u.startsWith('/api/state')&&!u.startsWith('/api/settings')){
    u=P+u;
  }else if(u instanceof Request){
    var url=new URL(u.url);
    if(url.origin===location.origin&&url.pathname.startsWith('/')&&!url.pathname.startsWith(P+'/')&&!url.pathname.startsWith('/api/preview')&&!url.pathname.startsWith('/api/terminal')&&!url.pathname.startsWith('/api/auth')&&!url.pathname.startsWith('/api/state')&&!url.pathname.startsWith('/api/settings')){
      u=new Request(P+url.pathname+url.search+url.hash,u);
    }
  }
  return _fetch.call(this,u,o);
};
var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(P+'/')&&!u.startsWith('/api/preview')&&!u.startsWith('/api/terminal')&&!u.startsWith('/api/auth')&&!u.startsWith('/api/state')&&!u.startsWith('/api/settings')){
    arguments[1]=P+u;
  }
  return _open.apply(this,arguments);
};
})();</script>` : '';

          const injectedScripts =
            (useLegacyPreviewFixes ? backdropFixCSS + animationFixCSS : '') +
            pathRewriteScript +
            PREVIEW_DEBUG_SCRIPT +
            (includePerformanceMonitor ? PERFORMANCE_MONITOR_SCRIPT : '') +
            inspectorScriptTag;
          // Use function replacement to avoid $' special pattern issues in injected scripts
          if (html.includes('<head>')) {
            html = html.replace('<head>', () => '<head>' + injectedScripts);
          } else if (html.includes('<html>')) {
            html = html.replace('<html>', () => '<html><head>' + injectedScripts + '</head>');
          } else {
            html = injectedScripts + html;
          }

            reply.header('content-length', String(Buffer.byteLength(html)));
            reply.raw.removeHeader('content-encoding');
            reply.send(html);
        } else if (isCss) {
          const css = rewriteCssText(body.toString('utf-8'), cacheBuster, rewriteUrlValue);
          reply.header('content-length', String(Buffer.byteLength(css)));
          reply.raw.removeHeader('content-encoding');
          reply.send(css);
        } else if (isJs && isPathPreview) {
          const js = rewriteJsImports(body.toString('utf-8'), cacheBuster, rewriteUrlValue, shouldBustScripts);
          reply.header('content-length', String(Buffer.byteLength(js)));
          reply.raw.removeHeader('content-encoding');
          reply.send(js);
        } else {
            reply.header('content-length', String(body.byteLength));
            reply.send(body);
          }
          responseSize = body.byteLength;
        }
      } else {
        reply.send();
        responseSize = 0;
      }

      // Prepare headers for logging (filter sensitive data)
      const requestHeadersForLog = filterHeaders(forwardHeaders);
      const responseHeadersForLog: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeadersForLog[key] = value;
      }
      const filteredResponseHeaders = filterHeaders(responseHeadersForLog);

      // Capture request body for logging (text-based only)
      let requestBodyForLog: string | undefined;
      let requestBodyTruncated = false;
      if (body && requestBodySize && requestBodySize < 100 * 1024) {
        const reqContentType = forwardHeaders['content-type'] || '';
        if (reqContentType.includes('json') || reqContentType.includes('text') ||
            reqContentType.includes('xml') || reqContentType.includes('form-urlencoded')) {
          const { body: truncBody, truncated } = truncateBody(body.toString('utf-8'));
          requestBodyForLog = truncBody;
          requestBodyTruncated = truncated;
        }
      }

      // Capture response body for logging (text-based only)
      let responseBodyForLog: string | undefined;
      let responseBodyTruncated = false;
      const respContentType = response.headers.get('content-type') || '';
      if (respContentType.includes('json') || respContentType.includes('text') ||
          respContentType.includes('xml') || respContentType.includes('javascript')) {
        if (responseBodyBuffer && responseSize && responseSize < 100 * 1024) {
          try {
            const responseBodyText = responseBodyBuffer.toString('utf-8');
            const { body: truncBody, truncated } = truncateBody(responseBodyText);
            responseBodyForLog = truncBody;
            responseBodyTruncated = truncated;
          } catch {
            // Binary or encoding issue, skip
          }
        }
      }

      // Log the successful request with full details
      addProxyLog(port, {
        timestamp: startTime,
        method: request.method,
        url: request.url,
        status: response.status,
        statusText: response.statusText,
        duration,
        requestSize: requestBodySize,
        responseSize,
        contentType,
        error: null,
        requestHeaders: requestHeadersForLog,
        responseHeaders: filteredResponseHeaders,
        requestBody: requestBodyForLog,
        responseBody: responseBodyForLog,
        requestBodyTruncated,
        responseBodyTruncated
      });

      // Return to prevent further processing
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Log the failed request
      addProxyLog(port, {
        timestamp: Date.now(),
        method: request.method,
        url: request.url,
        status: null,
        statusText: null,
        duration: 0,
        requestSize: null,
        responseSize: null,
        contentType: null,
        error: message
      });

      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        reply.code(502).send({
          error: 'Dev server not running',
          message: `Cannot connect to localhost:${port}. Make sure your dev server is running.`,
          hint: `Start your dev server on port ${port} and try again.`
        });
        return reply;
      }

      reply.code(500).send({
        error: 'Proxy error',
        message
      });
      return reply;
    }
  });

  // Note: WebSocket proxy for HMR is handled separately via websocket upgrade detection
  // The onRequest hook above handles HTTP requests, but WebSocket upgrades need special handling
}
