export interface RewriteSetCookieOptions {
  previewHost: string;
  isSecureRequest: boolean;
  defaultSameSite?: 'lax' | 'strict' | 'none';
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

  if (sameSiteValue === 'none' && !hasSecure && options.isSecureRequest) {
    rewrittenAttributes.push('Secure');
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
  return headers.map((header) => rewriteSetCookieHeader(header, options));
}
