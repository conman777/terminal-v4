/**
 * Cookie Service
 *
 * Manages browser cookies: CRUD operations, import/export, and filtering.
 */

import type { Page } from 'playwright';
import type { Cookie, CookieFilter } from './automation-types.js';

/**
 * Get all cookies or filtered cookies
 */
export async function getCookies(page: Page, filter?: CookieFilter): Promise<Cookie[]> {
  const cookies = await page.context().cookies();

  let filteredCookies = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite as 'Strict' | 'Lax' | 'None'
  }));

  if (filter) {
    if (filter.name) {
      filteredCookies = filteredCookies.filter(c => c.name.includes(filter.name!));
    }
    if (filter.domain) {
      filteredCookies = filteredCookies.filter(c => c.domain.includes(filter.domain!));
    }
    if (filter.path) {
      filteredCookies = filteredCookies.filter(c => c.path === filter.path);
    }
  }

  return filteredCookies;
}

/**
 * Get a single cookie by name
 */
export async function getCookie(page: Page, name: string): Promise<Cookie | null> {
  const cookies = await getCookies(page, { name });
  return cookies.find(c => c.name === name) || null;
}

/**
 * Set a cookie with security enforcement
 */
export async function setCookie(
  page: Page,
  cookie: Cookie,
  options: { enforceSecurity?: boolean } = {}
): Promise<void> {
  // Default to enforcing security in production
  const enforceSecurity = options.enforceSecurity ?? (process.env.NODE_ENV === 'production');

  // Build secure cookie with defaults
  const secureCookie: any = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',

    // Enforce security flags
    httpOnly: enforceSecurity ? true : (cookie.httpOnly ?? true),
    secure: enforceSecurity ? true : (cookie.secure ?? true),
    sameSite: cookie.sameSite || 'Strict',

    expires: cookie.expires
  };

  // Validate domain matches current page
  const currentUrl = page.url();
  if (currentUrl) {
    const currentDomain = new URL(currentUrl).hostname;
    if (secureCookie.domain && !currentDomain.endsWith(secureCookie.domain.replace(/^\./, ''))) {
      throw new Error(`Cookie domain '${secureCookie.domain}' does not match page domain '${currentDomain}'`);
    }
  }

  await page.context().addCookies([secureCookie]);
}

/**
 * Set multiple cookies
 */
export async function setCookies(page: Page, cookies: Cookie[]): Promise<void> {
  await page.context().addCookies(cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite
  })));
}

/**
 * Delete a cookie by name
 */
export async function deleteCookie(page: Page, name: string): Promise<boolean> {
  const cookies = await page.context().cookies();
  const cookie = cookies.find(c => c.name === name);

  if (!cookie) {
    return false;
  }

  await page.context().clearCookies();
  await page.context().addCookies(cookies.filter(c => c.name !== name));

  return true;
}

/**
 * Delete multiple cookies by names
 */
export async function deleteCookies(page: Page, names: string[]): Promise<number> {
  const cookies = await page.context().cookies();
  const namesToDelete = new Set(names);

  const remainingCookies = cookies.filter(c => !namesToDelete.has(c.name));
  const deletedCount = cookies.length - remainingCookies.length;

  await page.context().clearCookies();
  if (remainingCookies.length > 0) {
    await page.context().addCookies(remainingCookies);
  }

  return deletedCount;
}

/**
 * Clear all cookies
 */
export async function clearCookies(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Export cookies to JSON
 */
export async function exportCookies(page: Page, filter?: CookieFilter): Promise<string> {
  const cookies = await getCookies(page, filter);
  return JSON.stringify(cookies, null, 2);
}

/**
 * Import cookies from JSON
 */
export async function importCookies(page: Page, json: string): Promise<number> {
  let cookies: Cookie[];

  try {
    cookies = JSON.parse(json);

    if (!Array.isArray(cookies)) {
      throw new Error('Invalid format: expected array of cookies');
    }

    // Validate cookie structure
    for (const cookie of cookies) {
      if (!cookie.name || !cookie.value || !cookie.domain || !cookie.path) {
        throw new Error('Invalid cookie: missing required fields (name, value, domain, path)');
      }
    }
  } catch (err: any) {
    throw new Error(`Failed to parse cookies JSON: ${err.message}`);
  }

  await setCookies(page, cookies);
  return cookies.length;
}

/**
 * Copy cookies from another session
 */
export async function copyCookies(fromPage: Page, toPage: Page, filter?: CookieFilter): Promise<number> {
  const cookies = await getCookies(fromPage, filter);
  await setCookies(toPage, cookies);
  return cookies.length;
}

/**
 * Get cookie statistics
 */
export async function getCookieStats(page: Page): Promise<{
  total: number;
  byDomain: Record<string, number>;
  httpOnly: number;
  secure: number;
  session: number;
  persistent: number;
}> {
  const cookies = await getCookies(page);

  const byDomain: Record<string, number> = {};
  let httpOnly = 0;
  let secure = 0;
  let session = 0;
  let persistent = 0;

  for (const cookie of cookies) {
    // Count by domain
    byDomain[cookie.domain] = (byDomain[cookie.domain] || 0) + 1;

    // Count flags
    if (cookie.httpOnly) httpOnly++;
    if (cookie.secure) secure++;

    // Count session vs persistent
    if (cookie.expires === -1 || !cookie.expires) {
      session++;
    } else {
      persistent++;
    }
  }

  return {
    total: cookies.length,
    byDomain,
    httpOnly,
    secure,
    session,
    persistent
  };
}

/**
 * Validate cookie security flags
 */
export function validateCookieSecurity(cookie: Cookie): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (!cookie.httpOnly) {
    warnings.push('Cookie should have HttpOnly flag to prevent XSS attacks');
  }

  if (!cookie.secure) {
    warnings.push('Cookie should have Secure flag to prevent transmission over HTTP');
  }

  if (cookie.sameSite !== 'Strict' && cookie.sameSite !== 'Lax') {
    warnings.push('Cookie should have SameSite flag to prevent CSRF attacks');
  }

  return {
    valid: warnings.length === 0,
    warnings
  };
}
