import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { EventEmitter } from 'node:events';
import type { TerminalProcess, TerminalSpawnOptions } from '../src/terminal/terminal-types';
import { createServer } from '../src/index';
import { rewriteSetCookieHeader } from '../src/preview/cookie-rewrite';

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

  it('adds Secure for SameSite=None on secure requests', () => {
    const input = 'sid=abc; SameSite=None';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe('sid=abc; SameSite=None; Secure');
  });

  it('normalizes invalid SameSite values', () => {
    const input = 'flag=on; SameSite=Invalid';
    const output = rewriteSetCookieHeader(input, options);
    expect(output).toBe('flag=on; SameSite=Lax');
  });
});

describe('preview subdomain proxy', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
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
        .set('Host', 'preview-5173.conordart.com')
        .set('x-forwarded-proto', 'https')
        .expect(200);

      expect(res.headers['set-cookie']).toEqual([
        'gb_session=abc; Domain=preview-5173.conordart.com; Path=/; SameSite=Lax'
      ]);
    });
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
      expect(res.text).toContain('_cb=');
    });
  });
});
