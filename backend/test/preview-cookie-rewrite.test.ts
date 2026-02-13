import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { EventEmitter } from 'node:events';
import type { TerminalProcess, TerminalSpawnOptions } from '../src/terminal/terminal-types';
import { createServer } from '../src/index';
import { rewriteSetCookieHeader, rewriteSetCookieHeaders } from '../src/preview/cookie-rewrite';
import { clearCookies, hasCookies, listCookies, storeCookies } from '../src/preview/cookie-store';

class FakeTerminalProcess extends EventEmitter implements TerminalProcess {
  write(): void {}
  resize(): void {}
  kill(): void {}
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof createServer>>) => Promise<T>): Promise<T> {
  const spawnMock = (_options: TerminalSpawnOptions) => new FakeTerminalProcess();
  const app = await createServer({ logger: false, terminalOptions: { spawnTerminal: spawnMock } });
  await app.listen({ port: 0 });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

function getHeaderValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(expected) ?? headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [headerName, value] of headers) {
      if (headerName.toLowerCase() === expected) return value;
    }
    return undefined;
  }
  const record = headers as Record<string, string | undefined>;
  for (const [headerName, value] of Object.entries(record)) {
    if (headerName.toLowerCase() === expected) return value;
  }
  return undefined;
}

function getCookieHeaderValue(headers: HeadersInit | undefined): string | undefined {
  return getHeaderValue(headers, 'cookie');
}

describe('rewriteSetCookieHeader', () => {
  const options = {
    previewHost: 'preview-5173.conordart.com',
    isSecureRequest: true,
    defaultSameSite: 'lax' as const
  };

  it('rewrites invalid domain to preview host', () => {
    const input = 'gb_session=abc; Path=/; Domain=localhost; SameSite=Lax';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe(
      'gb_session=abc; Path=/; Domain=preview-5173.conordart.com; SameSite=Lax'
    );
  });

  it('keeps a valid parent domain unchanged', () => {
    const input = 'theme=dark; Domain=.conordart.com; Path=/';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe(input);
  });

  it('drops Domain for __Host- cookies', () => {
    const input = '__Host-id=abc; Domain=localhost; Path=/; Secure';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe('__Host-id=abc; Path=/; Secure');
  });

  it('adds Secure and Partitioned for SameSite=None on secure requests', () => {
    const input = 'sid=abc; SameSite=None';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe('sid=abc; SameSite=None; Secure; Partitioned');
  });

  it('normalizes invalid SameSite values', () => {
    const input = 'flag=on; SameSite=Invalid';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe('flag=on; SameSite=Lax');
  });

  it('emits host-only companion for domain-based deletion cookies', () => {
    const input = 'sid=; Max-Age=0; Domain=localhost; Path=/';
    const output = rewriteSetCookieHeaders([input], options);
    expect(output).toEqual([
      'sid=; Max-Age=0; Domain=preview-5173.conordart.com; Path=/',
      'sid=; Max-Age=0; Path=/'
    ]);
  });
});

describe('preview subdomain proxy', () => {
  const originalFetch = global.fetch;
  const TEST_PORT = 55173;
  const TEST_HOST = `preview-${TEST_PORT}.conordart.com`;

  beforeEach(() => {
    clearCookies(TEST_PORT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies(TEST_PORT);
    global.fetch = originalFetch;
  });

  it('forwards rewritten Set-Cookie headers to the browser', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'gb_session=abc; Domain=localhost; Path=/; SameSite=Lax');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('ok', {
          status: 200,
          headers
        })
      )
    );

    await withApp(async (app) => {
      const res = await supertest(app.server)
        .get('/dashboard')
        .set('Host', TEST_HOST)
        .set('x-forwarded-proto', 'https')
        .expect(200);

      expect(res.headers['set-cookie']).toEqual([
        `gb_session=abc; Domain=${TEST_HOST}; Path=/; SameSite=Lax`
      ]);
      expect(hasCookies(TEST_PORT)).toBe(true);
    });
  });

  it('does not persist cookie jar for path-based preview responses', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/; SameSite=Lax');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('ok', {
          status: 200,
          headers
        })
      )
    );

    await withApp(async (app) => {
      await supertest(app.server)
        .get(`/preview/${TEST_PORT}/dashboard`)
        .set('Host', 'localhost:3000')
        .expect(200);
    });

    expect(hasCookies(TEST_PORT)).toBe(false);
  });

  it('injects stored cookies only for subdomain preview requests', async () => {
    storeCookies(TEST_PORT, ['server_sid=abc123; Path=/; SameSite=Lax']);
    let observedSubdomainCookieHeader: string | undefined;
    let observedPathCookieHeader: string | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(_input);
        const cookie = getCookieHeaderValue(init?.headers as HeadersInit | undefined);
        if (url.includes('/subdomain-check')) {
          observedSubdomainCookieHeader = cookie;
        } else if (url.includes('/path-check')) {
          observedPathCookieHeader = cookie;
        }
        return new Response('ok', { status: 200 });
      })
    );

    await withApp(async (app) => {
      await supertest(app.server)
        .get('/subdomain-check')
        .set('Host', TEST_HOST)
        .expect(200);

      await supertest(app.server)
        .get(`/preview/${TEST_PORT}/path-check`)
        .set('Host', 'localhost:3000')
        .expect(200);
    });

    expect(observedSubdomainCookieHeader).toContain('server_sid=abc123');
    expect(observedPathCookieHeader || '').not.toContain('server_sid=abc123');
  });

  it('rewrites forwarded origin and referer headers to virtual localhost origin', async () => {
    let observedOriginHeader: string | undefined;
    let observedRefererHeader: string | undefined;
    let observedForwardedHost: string | undefined;
    let observedForwardedProto: string | undefined;
    let observedForwardedPort: string | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedOriginHeader = getHeaderValue(init?.headers as HeadersInit | undefined, 'origin');
        observedRefererHeader = getHeaderValue(init?.headers as HeadersInit | undefined, 'referer');
        observedForwardedHost = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-host');
        observedForwardedProto = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-proto');
        observedForwardedPort = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-port');
        return new Response('ok', { status: 200 });
      })
    );

    await withApp(async (app) => {
      await supertest(app.server)
        .post('/api/auth/logout')
        .set('Host', TEST_HOST)
        .set('x-forwarded-proto', 'https')
        .set('Origin', `https://${TEST_HOST}`)
        .set('Referer', `https://${TEST_HOST}/dashboard?tab=profile`)
        .send({ reason: 'user-action' })
        .expect(200);
    });

    expect(observedOriginHeader).toBe(`http://localhost:${TEST_PORT}`);
    expect(observedRefererHeader).toBe(`http://localhost:${TEST_PORT}/dashboard?tab=profile`);
    expect(observedForwardedHost).toBe(`localhost:${TEST_PORT}`);
    expect(observedForwardedProto).toBe('http');
    expect(observedForwardedPort).toBe(String(TEST_PORT));
  });

  it('rewrites path-based referer by removing preview base prefix', async () => {
    let observedOriginHeader: string | undefined;
    let observedRefererHeader: string | undefined;
    let observedForwardedHost: string | undefined;
    let observedForwardedProto: string | undefined;
    let observedForwardedPort: string | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedOriginHeader = getHeaderValue(init?.headers as HeadersInit | undefined, 'origin');
        observedRefererHeader = getHeaderValue(init?.headers as HeadersInit | undefined, 'referer');
        observedForwardedHost = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-host');
        observedForwardedProto = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-proto');
        observedForwardedPort = getHeaderValue(init?.headers as HeadersInit | undefined, 'x-forwarded-port');
        return new Response('ok', { status: 200 });
      })
    );

    await withApp(async (app) => {
      await supertest(app.server)
        .post(`/preview/${TEST_PORT}/api/auth/logout`)
        .set('Host', 'localhost:3020')
        .set('Origin', 'http://localhost:3020')
        .set('Referer', `http://localhost:3020/preview/${TEST_PORT}/dashboard/settings?mode=security`)
        .send({ reason: 'manual' })
        .expect(200);
    });

    expect(observedOriginHeader).toBe(`http://localhost:${TEST_PORT}`);
    expect(observedRefererHeader).toBe(`http://localhost:${TEST_PORT}/dashboard/settings?mode=security`);
    expect(observedForwardedHost).toBe(`localhost:${TEST_PORT}`);
    expect(observedForwardedProto).toBe('http');
    expect(observedForwardedPort).toBe(String(TEST_PORT));
  });

  it('rewrites path-based redirect locations to stay under preview base path', async () => {
    const headers = new Headers();
    headers.set('location', '/api/auth/signin?callbackUrl=%2Fdashboard');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('redirect', {
          status: 307,
          headers
        })
      )
    );

    await withApp(async (app) => {
      const res = await supertest(app.server)
        .get(`/preview/${TEST_PORT}/dashboard`)
        .set('Host', 'localhost:3020')
        .expect(307);

      expect(res.headers.location).toBe(`/preview/${TEST_PORT}/api/auth/signin?callbackUrl=%2Fdashboard`);
    });
  });

  it('clears preview cookie jars when user logs out', async () => {
    storeCookies(TEST_PORT, ['server_sid=abc123; Path=/; SameSite=Lax']);
    expect(hasCookies(TEST_PORT)).toBe(true);

    await withApp(async (app) => {
      const username = `preview-logout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const password = 'Password123!';
      const registerRes = await supertest(app.server)
        .post('/api/auth/register')
        .send({ username, password })
        .expect(200);

      const accessToken = registerRes.body?.tokens?.accessToken;
      expect(typeof accessToken).toBe('string');

      const logoutRes = await supertest(app.server)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(logoutRes.body?.success).toBe(true);
    });

    expect(hasCookies(TEST_PORT)).toBe(false);
  });

  it('clears stale server-side cookie variants when receiving delete cookie', () => {
    storeCookies(TEST_PORT, [
      'session=alive; Path=/; SameSite=Lax',
      'session=alive2; Path=/dashboard; SameSite=Lax',
      'theme=dark; Path=/; SameSite=Lax'
    ]);

    expect(listCookies(TEST_PORT).some((cookie) => cookie.name === 'session')).toBe(true);

    storeCookies(TEST_PORT, ['session=; Max-Age=0; Domain=localhost; Path=/']);

    const remaining = listCookies(TEST_PORT);
    expect(remaining.some((cookie) => cookie.name === 'session')).toBe(false);
    expect(remaining.some((cookie) => cookie.name === 'theme')).toBe(true);
  });

  it('recalculates content-length for modified HTML responses', async () => {
    const html = '<html><head><script src="/app.js"></script></head><body><div>Login</div></body></html>';
    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('content-length', String(Buffer.byteLength(html)));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(html, {
          status: 200,
          headers
        })
      )
    );

    await withApp(async (app) => {
      const res = await supertest(app.server)
        .get('/login')
        .set('Host', 'preview-5173.conordart.com')
        .set('x-forwarded-proto', 'https')
        .expect(200);

      const responseLength = Number(res.headers['content-length']);
      expect(responseLength).toBe(Buffer.byteLength(res.text));
      expect(res.text).toContain('__previewDebugInjected');
      expect(res.text).toContain('window.EventSource = function(url, options)');
      expect(res.text).toContain('navigator.sendBeacon = function(url, data)');
      expect(res.text).not.toContain('preview-storage-request');
      expect(res.text).toContain('<script src="/app.js"></script>');
    });
  });
});
