// Server-side cookie store for preview proxy
// Acts as a browser-like cookie jar for each previewed app

import { parse as parseCookie, serialize as serializeCookie } from 'cookie';

interface StoredCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  createdAt: number;
}

// Cookie store keyed by port number
const cookieStores = new Map<number, Map<string, StoredCookie>>();

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
    return Date.now() > cookie.expires.getTime();
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
export function storeCookies(port: number, setCookieHeaders: string[]): void {
  if (!cookieStores.has(port)) {
    cookieStores.set(port, new Map());
  }
  const store = cookieStores.get(port)!;

  for (const header of setCookieHeaders) {
    const cookie = parseSetCookie(header);
    if (cookie) {
      // Use name+path as key for proper cookie replacement
      const key = `${cookie.name}:${cookie.path || '/'}`;

      // Check if this is a delete operation (empty value or past expiry)
      if (cookie.value === '' ||
          (cookie.expires && cookie.expires.getTime() < Date.now()) ||
          (cookie.maxAge !== undefined && cookie.maxAge <= 0)) {
        store.delete(key);
      } else {
        store.set(key, cookie);
      }
    }
  }
}

/**
 * Get Cookie header value for a request
 */
export function getCookieHeader(port: number, requestPath: string): string | null {
  const store = cookieStores.get(port);
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
export function clearCookies(port: number): void {
  cookieStores.delete(port);
}

/**
 * Get all stored cookies for a port (for debugging/display)
 */
export function listCookies(port: number): Array<{ name: string; value: string; path?: string }> {
  const store = cookieStores.get(port);
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
export function hasCookies(port: number): boolean {
  const store = cookieStores.get(port);
  return store !== undefined && store.size > 0;
}
