const CONFIGURED_API_BASE = import.meta.env.VITE_API_URL || '';

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function resolveApiBase(configuredBase = CONFIGURED_API_BASE, locationLike = typeof window !== 'undefined' ? window.location : null) {
  if (!configuredBase) {
    return '';
  }

  try {
    const fallbackOrigin = locationLike?.origin || 'http://localhost';
    const resolved = new URL(configuredBase, fallbackOrigin);

    if (locationLike && isLoopbackHostname(resolved.hostname) && isLoopbackHostname(locationLike.hostname)) {
      const pathname = resolved.pathname === '/' ? '' : resolved.pathname.replace(/\/$/, '');
      return `${locationLike.origin}${pathname}`;
    }

    const pathname = resolved.pathname === '/' ? '' : resolved.pathname.replace(/\/$/, '');
    return `${resolved.origin}${pathname}`;
  } catch {
    return configuredBase;
  }
}

export function resolveApiUrl(pathname, configuredBase = CONFIGURED_API_BASE, locationLike = typeof window !== 'undefined' ? window.location : null) {
  const base = resolveApiBase(configuredBase, locationLike);
  return pathname.startsWith('http') ? pathname : `${base}${pathname}`;
}
