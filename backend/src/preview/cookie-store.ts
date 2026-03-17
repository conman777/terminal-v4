// Server-side cookie store for preview proxy
// Acts as a browser-like cookie jar for each previewed app
// Persists to disk so cookies survive backend restarts

import { parse as parseCookie } from 'cookie';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDataDir } from '../utils/data-dir';
import { getPreviewStoreKey } from './preview-scope.js';

interface StoredCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date | string; // Can be string when loaded from JSON
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  createdAt: number;
}

// Cookie store keyed by scope+port.
const cookieStores = new Map<string, Map<string, StoredCookie>>();

// Persistence configuration
const DATA_DIR = ensureDataDir();
const COOKIE_FILE = path.join(DATA_DIR, 'preview-cookies.json');
let saveTimeout: NodeJS.Timeout | null = null;

// Load cookies from disk on startup
function loadCookiesFromDisk(): void {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return;

    const data = fs.readFileSync(COOKIE_FILE, 'utf-8');
    const parsed = JSON.parse(data) as Record<string, Record<string, StoredCookie>>;

    for (const [storeKey, cookies] of Object.entries(parsed)) {
      const portStore = new Map<string, StoredCookie>();

      for (const [key, cookie] of Object.entries(cookies)) {
        // Convert expires string back to Date if present
        if (cookie.expires) {
          cookie.expires = new Date(cookie.expires);
        }
        // Skip expired cookies
        if (!isCookieExpired(cookie)) {
          portStore.set(key, cookie);
        }
      }

      if (portStore.size > 0) {
        cookieStores.set(storeKey, portStore);
      }
    }

    console.log(`[cookie-store] Loaded cookies for ${cookieStores.size} preview scope(s)`);
  } catch (err) {
    console.error('[cookie-store] Failed to load cookies from disk:', err);
  }
}

// Save cookies to disk (debounced)
function saveCookiesToDisk(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const data: Record<string, Record<string, StoredCookie>> = {};

      for (const [storeKey, store] of cookieStores.entries()) {
        const portCookies: Record<string, StoredCookie> = {};
        for (const [key, cookie] of store.entries()) {
          // Skip expired cookies when saving
          if (!isCookieExpired(cookie)) {
            portCookies[key] = cookie;
          }
        }
        if (Object.keys(portCookies).length > 0) {
          data[storeKey] = portCookies;
        }
      }

      fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[cookie-store] Failed to save cookies to disk:', err);
    }
  }, 1000); // Debounce 1 second
}

// Load cookies on module initialization
loadCookiesFromDisk();

// Parse Set-Cookie header into StoredCookie
function parseSetCookie(header: string): StoredCookie | null {
  const parts = header.split(';').map(p => p.trim());
  if (parts.length === 0) return null;

  // First part is name=value
  const [nameValue, ...attributes] = parts;
  const eqIndex = nameValue.indexOf('=');
  if (eqIndex === -1) return null;

  const name = nameValue.substring(0, eqIndex).trim();
  const value = nameValue.substring(eqIndex + 1).trim();

  const cookie: StoredCookie = {
    name,
    value,
    createdAt: Date.now(),
  };

  // Parse attributes
  for (const attr of attributes) {
    const [attrName, attrValue] = attr.split('=').map(s => s.trim());
    const lowerAttrName = attrName.toLowerCase();

    switch (lowerAttrName) {
      case 'path':
        cookie.path = attrValue;
        break;
      case 'domain':
        cookie.domain = attrValue;
        break;
      case 'expires':
        cookie.expires = new Date(attrValue);
        break;
      case 'max-age':
        cookie.maxAge = parseInt(attrValue, 10);
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = attrValue.toLowerCase() as 'strict' | 'lax' | 'none';
        break;
    }
  }

  return cookie;
}

// Check if a cookie is expired
function isCookieExpired(cookie: StoredCookie): boolean {
  if (cookie.maxAge !== undefined) {
    const expiresAt = cookie.createdAt + cookie.maxAge * 1000;
    return Date.now() > expiresAt;
  }
  if (cookie.expires) {
    // Handle both Date objects and strings (from JSON deserialization)
    const expiresTime = cookie.expires instanceof Date
      ? cookie.expires.getTime()
      : new Date(cookie.expires).getTime();
    return Date.now() > expiresTime;
  }
  return false; // Session cookie, never expires (until cleared)
}

// Check if cookie path matches request path
function pathMatches(cookiePath: string | undefined, requestPath: string): boolean {
  if (!cookiePath || cookiePath === '/') return true;

  // Normalize paths
  const normCookiePath = cookiePath.endsWith('/') ? cookiePath.slice(0, -1) : cookiePath;
  const normRequestPath = requestPath.endsWith('/') ? requestPath.slice(0, -1) : requestPath;

  // Cookie path must be prefix of request path
  return normRequestPath === normCookiePath || normRequestPath.startsWith(normCookiePath + '/');
}

/**
 * Store cookies from Set-Cookie headers
 */
export function storeCookies(scopeId: string, port: number, setCookieHeaders: string[]): void {
  const storeKey = getPreviewStoreKey(scopeId, port);
  if (!cookieStores.has(storeKey)) {
    cookieStores.set(storeKey, new Map());
  }
  const store = cookieStores.get(storeKey)!;

  for (const header of setCookieHeaders) {
    const cookie = parseSetCookie(header);
    if (!cookie) {
      console.warn(`[cookie-store] Failed to parse Set-Cookie header: ${header.substring(0, 100)}${header.length > 100 ? '...' : ''}`);
      continue;
    }

    // Use name+path as key for proper cookie replacement
    const key = `${cookie.name}:${cookie.path || '/'}`;

    // Check if this is a delete operation (empty value or past expiry)
    const expiresTime = cookie.expires instanceof Date
      ? cookie.expires.getTime()
      : cookie.expires ? new Date(cookie.expires).getTime() : null;

    if (cookie.value === '' ||
        (expiresTime && expiresTime < Date.now()) ||
        (cookie.maxAge !== undefined && cookie.maxAge <= 0)) {
      store.delete(key);
    } else {
      store.set(key, cookie);
    }
  }

  // Persist to disk
  saveCookiesToDisk();
}

/**
 * Get Cookie header value for a request
 */
export function getCookieHeader(scopeId: string, port: number, requestPath: string): string | null {
  const store = cookieStores.get(getPreviewStoreKey(scopeId, port));
  if (!store || store.size === 0) return null;

  const cookies: string[] = [];
  const expiredKeys: string[] = [];

  for (const [key, cookie] of store.entries()) {
    // Check expiration
    if (isCookieExpired(cookie)) {
      expiredKeys.push(key);
      continue;
    }

    // Check path match
    if (!pathMatches(cookie.path, requestPath)) {
      continue;
    }

    cookies.push(`${cookie.name}=${cookie.value}`);
  }

  // Clean up expired cookies
  for (const key of expiredKeys) {
    store.delete(key);
  }

  return cookies.length > 0 ? cookies.join('; ') : null;
}

/**
 * Clear all cookies for a port
 */
export function clearCookies(scopeId: string, port: number): void {
  cookieStores.delete(getPreviewStoreKey(scopeId, port));
  saveCookiesToDisk();
}

/**
 * Get all stored cookies for a port (for debugging/display)
 */
export function listCookies(scopeId: string, port: number): Array<{ name: string; value: string; path?: string }> {
  const store = cookieStores.get(getPreviewStoreKey(scopeId, port));
  if (!store) return [];

  const result: Array<{ name: string; value: string; path?: string }> = [];

  for (const cookie of store.values()) {
    if (!isCookieExpired(cookie)) {
      result.push({
        name: cookie.name,
        value: cookie.value.length > 20 ? cookie.value.substring(0, 20) + '...' : cookie.value,
        path: cookie.path,
      });
    }
  }

  return result;
}

/**
 * Check if a port has any stored cookies
 */
export function hasCookies(scopeId: string, port: number): boolean {
  const store = cookieStores.get(getPreviewStoreKey(scopeId, port));
  return store !== undefined && store.size > 0;
}
