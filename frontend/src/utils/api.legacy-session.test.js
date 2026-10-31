import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiPost } from './api';
import { clearTokens, setAuthInitializing, setTokens, setUser } from './auth';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const signIn = (name) => {
  setTokens(`${name}-access`, `${name}-refresh`);
  setUser({ id: name });
};

describe('legacy API responses across session changes', () => {
  beforeEach(() => {
    localStorage.clear();
    setAuthInitializing(false);
    signIn('first-owner');
  });
  afterEach(() => {
    clearTokens(true);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('rejects an old account response that arrives after a different login', async () => {
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = apiFetch('/api/test').catch(error => error);
    signIn('second-owner');
    pending.resolve(new Response(JSON.stringify({ private: 'first-owner' }), { status: 200 }));
    expect((await result).message).toBe('Authentication changed');
  });

  it('marks a submitted mutation uncertain if its response arrives after logout', async () => {
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = apiFetch('/api/test', { method: 'POST', body: { value: 'draft' } }).catch(error => error);
    clearTokens(true);
    pending.resolve(new Response('{}', { status: 200 }));
    const error = await result;
    expect([error.message, error.outcomeUncertain, fetch.mock.calls.length]).toEqual(['Authentication changed; request outcome may be unconfirmed', true, 1]);
  });

  it('does not expose a decoded response after the session changes during body reading', async () => {
    const body = deferred();
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: () => body.promise })));
    const response = await apiFetch('/api/test');
    const result = response.json().catch(error => error);
    signIn('second-owner');
    body.resolve({ private: 'first-owner' });
    expect((await result).message).toBe('Authentication changed');
  });

  it('preserves the uncertain mutation outcome if an error body arrives after logout', async () => {
    const body = deferred();
    const reading = deferred();
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 409, ok: false, json: () => { reading.resolve(); return body.promise; } })));
    const result = apiPost('/api/test', { value: 'draft' }).catch(error => error);
    await reading.promise;
    clearTokens(true);
    body.resolve({ error: 'old account conflict' });
    const error = await result;
    expect([error.message, error.outcomeUncertain]).toEqual(['Authentication changed; request outcome may be unconfirmed', true]);
  });

  it('rejects a stream chunk that arrives after another account signs in', async () => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const response = await apiFetch('/api/test');
    const reader = response.body.getReader();
    const next = reader.read().catch(error => error);
    signIn('second-owner');
    controller.enqueue(new TextEncoder().encode('first-owner private data'));
    expect((await next).message).toBe('Authentication changed');
    reader.releaseLock();
  });

  it('keeps ordinary streaming and body decoding usable within the same session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"value":"ok"}', { status: 200 })));
    const streamed = await apiFetch('/api/test');
    const reader = streamed.body.getReader();
    const chunks = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(new TextDecoder().decode(part.value));
    }
    reader.releaseLock();
    const decoded = await apiFetch('/api/test');
    expect(decoded.body).toBeTruthy();
    expect([chunks.join(''), await decoded.json()]).toEqual(['{"value":"ok"}', { value: 'ok' }]);
  });

  it('supports byte-oriented stream readers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const response = await apiFetch('/api/test');
    const reader = response.body.getReader({ mode: 'byob' });
    const part = await reader.read(new Uint8Array(8));
    expect(new TextDecoder().decode(part.value)).toBe('ok');
    expect((await reader.read(new Uint8Array(8))).done).toBe(true);
    reader.releaseLock();
  });
});
