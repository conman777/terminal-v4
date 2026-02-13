export interface RewriteSetCookieOptions {
  previewHost: string;
  isSecureRequest: boolean;
  defaultSameSite?: 'lax' | 'strict' | 'none';
  forceSameSite?: 'lax' | 'strict' | 'none';
}

interface ParsedAttribute {
  raw: string;
  keyLower: string;
  value?: string;
}

function normalizeHost(host: string): string {
  return host.split(':')[0].toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, '').split(':')[0].toLowerCase();
}

function domainMatches(cookieDomain: string, previewHost: string): boolean {
  const normalizedDomain = normalizeDomain(cookieDomain);
  const normalizedHost = normalizeHost(previewHost);
  if (!normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function normalizeSameSite(value?: string): 'lax' | 'strict' | 'none' | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
    return normalized;
  }
  return undefined;
}

function formatSameSite(value: 'lax' | 'strict' | 'none'): string {
  if (value === 'lax') return 'Lax';
  if (value === 'strict') return 'Strict';
  return 'None';
}

function parseSetCookieAttributes(parts: string[]): ParsedAttribute[] {
  return parts
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawKey, ...rest] = part.split('=');
      return {
        raw: part,
        keyLower: rawKey.trim().toLowerCase(),
        value: rest.length > 0 ? rest.join('=').trim() : undefined
      };
    });
}

function parseCookieNameValue(nameValue: string): { name: string; value: string } | null {
  const eqIndex = nameValue.indexOf('=');
  if (eqIndex < 0) {
    return null;
  }
  const name = nameValue.slice(0, eqIndex).trim();
  const value = nameValue.slice(eqIndex + 1).trim();
  if (!name) {
    return null;
  }
  return { name, value };
}

function parseMaxAgeSeconds(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExpiresMillis(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCookieDeletionHeader(header: string): boolean {
  const segments = header.split(';');
  const nameValue = segments.shift()?.trim();
  if (!nameValue) return false;
  const parsedNameValue = parseCookieNameValue(nameValue);
  if (!parsedNameValue) return false;
  if (parsedNameValue.value === '') return true;

  const attributes = parseSetCookieAttributes(segments);
  const maxAgeAttr = attributes.find((attr) => attr.keyLower === 'max-age');
  const maxAgeSeconds = parseMaxAgeSeconds(maxAgeAttr?.value);
  if (maxAgeSeconds !== null && maxAgeSeconds <= 0) {
    return true;
  }

  const expiresAttr = attributes.find((attr) => attr.keyLower === 'expires');
  const expiresMillis = parseExpiresMillis(expiresAttr?.value);
  if (expiresMillis !== null && expiresMillis <= Date.now()) {
    return true;
  }

  return false;
}

function hasDomainAttribute(header: string): boolean {
  const segments = header.split(';');
  segments.shift();
  const attributes = parseSetCookieAttributes(segments);
  return attributes.some((attr) => attr.keyLower === 'domain');
}

function stripAttribute(header: string, attribute: string): string {
  const segments = header.split(';');
  const nameValue = segments.shift()?.trim();
  if (!nameValue || !nameValue.includes('=')) {
    return header;
  }
  const attributes = parseSetCookieAttributes(segments)
    .filter((attr) => attr.keyLower !== attribute)
    .map((attr) => attr.raw);
  if (attributes.length === 0) {
    return nameValue;
  }
  return `${nameValue}; ${attributes.join('; ')}`;
}

export function rewriteSetCookieHeader(header: string, options: RewriteSetCookieOptions): string {
  const segments = header.split(';');
  const nameValue = segments.shift()?.trim();
  if (!nameValue || !nameValue.includes('=')) {
    return header;
  }

  const cookieName = nameValue.split('=')[0]?.trim();
  if (!cookieName) {
    return header;
  }

  const isHostCookie = cookieName.toLowerCase().startsWith('__host-');
  const previewHost = normalizeHost(options.previewHost);
  const attributes = parseSetCookieAttributes(segments);

  const rewrittenAttributes: string[] = [];
  let hasSecure = false;
  let sameSiteValue: 'lax' | 'strict' | 'none' | undefined;
  const forcedSameSite = options.forceSameSite;

  for (const attr of attributes) {
    switch (attr.keyLower) {
      case 'domain': {
        if (isHostCookie) {
          break;
        }
        const domainValue = attr.value ?? '';
        if (domainValue && !domainMatches(domainValue, previewHost)) {
          rewrittenAttributes.push(`Domain=${previewHost}`);
        } else {
          rewrittenAttributes.push(attr.raw);
        }
        break;
      }
      case 'samesite': {
        if (forcedSameSite) {
          break;
        }
        const normalized = normalizeSameSite(attr.value);
        const fallback = options.defaultSameSite;
        const finalValue = normalized ?? fallback;
        if (finalValue) {
          sameSiteValue = finalValue;
          rewrittenAttributes.push(`SameSite=${formatSameSite(finalValue)}`);
        }
        break;
      }
      case 'secure':
        hasSecure = true;
        rewrittenAttributes.push(attr.raw);
        break;
      default:
        rewrittenAttributes.push(attr.raw);
        break;
    }
  }

  if (forcedSameSite) {
    sameSiteValue = forcedSameSite;
    rewrittenAttributes.push(`SameSite=${formatSameSite(forcedSameSite)}`);
  }

  // SameSite=None requires Secure attribute per spec
  if (sameSiteValue === 'none' && !hasSecure) {
    rewrittenAttributes.push('Secure');
  }

  // Add Partitioned attribute for CHIPS compliance (third-party iframe context)
  if (sameSiteValue === 'none' && options.isSecureRequest) {
    rewrittenAttributes.push('Partitioned');
  }

  if (rewrittenAttributes.length === 0) {
    return nameValue;
  }

  return `${nameValue}; ${rewrittenAttributes.join('; ')}`;
}

export function rewriteSetCookieHeaders(
  headers: string[],
  options: RewriteSetCookieOptions
): string[] {
  const rewritten: string[] = [];
  for (const header of headers) {
    const primary = rewriteSetCookieHeader(header, options);
    rewritten.push(primary);

    // Some apps set host-only cookies but clear them with a Domain attribute.
    // Emit a host-only deletion companion so both variants are cleared.
    if (isCookieDeletionHeader(primary) && hasDomainAttribute(primary)) {
      const hostOnlyDeletion = stripAttribute(primary, 'domain');
      if (hostOnlyDeletion !== primary) {
        rewritten.push(hostOnlyDeletion);
      }
    }
  }
  return rewritten;
}
