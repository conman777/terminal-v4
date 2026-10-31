import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserAuthAuthority } from './standaloneIndexedDbAuthAuthority';
import { createBrowserAuthLifecycle } from './browserAuthLifecycle';
import { createSessionLogoutTransport } from './sessionLogoutTransport';

const home = 'http://127.0.0.1:43123/prefix/';
const scope = {
  home,
  owner: 'synthetic-owner',
  session: '59d5fe7a-2b4c-467d-a11e-2bd1718ccf01',
  operation: '59d5fe7a-2b4c-467d-a11e-2bd1718ccf02',
  incarnation: '59d5fe7a-2b4c-467d-a11e-2bd1718ccf03',
  logoutCapability: 'a'.repeat(64),
};
const serverReceipt = value => ({
  status: 'revoked', owner: value.owner, session: value.session,
  operation: value.operation, incarnation: value.incarnation,
});
const response = (url, value, { status = 200, contentType = 'application/json', redirected = false } = {}) => {
  const result = new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': contentType } });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: redirected } });
  return result;
};

describe('session logout transport', () => {
  it('independently queries the pinned home and binds every receipt field', async () => {
    const fetchImpl = vi.fn(async url => response(url, serverReceipt(scope)));
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    expect(await transport.verifyLogoutReceipt({ ...scope, receipt: { status: 'forged' } })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${home}api/auth/session-logout/receipt`);
    expect(options).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(options.body)).toEqual({ owner: scope.owner, session: scope.session, operation: scope.operation, incarnation: scope.incarnation, logoutCapability: scope.logoutCapability });
  });

  it('sends the exact revocation scope but does not export the response as proof', async () => {
    const fetchImpl = vi.fn(async url => response(url, serverReceipt(scope)));
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    expect(await transport.logout(scope)).toEqual({ status: 'submitted' });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${home}api/auth/session-logout`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ owner: scope.owner, session: scope.session, operation: scope.operation, incarnation: scope.incarnation, logoutCapability: scope.logoutCapability });
  });

  it('rejects unconfirmed, malformed, redirected and mismatched responses', async () => {
    const badBodies = [
      { status: 'unconfirmed' },
      { ...serverReceipt(scope), owner: 'foreign-owner' },
      { ...serverReceipt(scope), session: 'other-session' },
      { ...serverReceipt(scope), operation: 'other-operation' },
      { ...serverReceipt(scope), incarnation: 'other-incarnation' },
      { ...serverReceipt(scope), logoutCapability: scope.logoutCapability },
      '{broken',
      'x'.repeat(5000),
    ];
    for (const body of badBodies) {
      const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl: async url => response(url, body) });
      expect(await transport.verifyLogoutReceipt({ ...scope, receipt: serverReceipt(scope) })).toBe(false);
    }
    for (const options of [{ status: 202 }, { status: 503 }, { contentType: 'text/html' }, { redirected: true }]) {
      const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl: async url => response(url, serverReceipt(scope), options) });
      expect(await transport.verifyLogoutReceipt({ ...scope })).toBe(false);
    }
    const foreign = createSessionLogoutTransport({ trustedHome: home, fetchImpl: async () => response('https://foreign.example/api/auth/session-logout/receipt', serverReceipt(scope)) });
    expect(await foreign.verifyLogoutReceipt(scope)).toBe(false);
  });

  it('rejects foreign homes and malformed scope before any request', async () => {
    const fetchImpl = vi.fn();
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    for (const bad of [
      { ...scope, home: 'http://127.0.0.1:43124/prefix/' },
      { ...scope, owner: 'bad\nowner' },
      { ...scope, owner: 'é'.repeat(129) },
      { ...scope, session: 'not-a-uuid' },
      { ...scope, operation: 'not-a-uuid' },
      { ...scope, incarnation: 'not-a-uuid' },
      { ...scope, logoutCapability: 'bad' },
    ]) {
      expect(await transport.verifyLogoutReceipt(bad)).toBe(false);
      await expect(transport.logout(bad)).rejects.toThrow('Logout outcome unconfirmed');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const bad of ['http://example.com/', 'https://user:password@example.com/', 'https://example.com/?query=1', 'https://example.com/#fragment', 'http://127.0.0.1:43123/prefix']) {
      expect(() => createSessionLogoutTransport({ trustedHome: bad, fetchImpl })).toThrow();
    }
  });

  it('never coerces object-valued identifiers into a different dispatched operation', async () => {
    const fetchImpl = vi.fn();
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    for (const field of ['session', 'operation', 'incarnation']) {
      const disguised = { toString: () => scope[field], toJSON: () => '59d5fe7a-2b4c-467d-a11e-2bd1718ccf99' };
      const altered = { ...scope, [field]: disguised };
      expect(await transport.verifyLogoutReceipt(altered)).toBe(false);
      await expect(transport.logout(altered)).rejects.toThrow('Logout outcome unconfirmed');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on cancellation and lost responses without leaking secrets', async () => {
    const fetchImpl = vi.fn(async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(`secret ${scope.logoutCapability}`)), { once: true })));
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    const controller = new AbortController();
    const pending = transport.logout({ ...scope, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toEqual(new Error('Logout outcome unconfirmed'));
    const aborted = new AbortController(); aborted.abort();
    expect(await transport.verifyLogoutReceipt({ ...scope, signal: aborted.signal })).toBe(false);
  });

  it('does not dispatch for invalid or throwing cancellation objects and never exports their errors', async () => {
    const fetchImpl = vi.fn();
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    const badSignal = { get aborted() { return false; }, addEventListener() { throw new Error(scope.logoutCapability); }, removeEventListener() {} };
    const invalid = { ...scope, signal: badSignal };
    expect(await transport.verifyLogoutReceipt(invalid)).toBe(false);
    await expect(transport.logout(invalid)).rejects.toThrow('Logout outcome unconfirmed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not read caller-supplied receipt objects while independently verifying', async () => {
    const fetchImpl = vi.fn(async url => response(url, serverReceipt(scope)));
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    const input = { ...scope, get receipt() { throw new Error(scope.logoutCapability); } };
    expect(await transport.verifyLogoutReceipt(input)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds a verifier whose transport never responds', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl, timeoutMs: 10 });
    expect(await transport.verifyLogoutReceipt(scope)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost logout response without trusting the response supplied by the caller', async () => {
    const indexedDB = new IDBFactory();
    let committed = false;
    const calls = [];
    const fetchImpl = async (url, options) => {
      const request = JSON.parse(options.body);
      calls.push({ url, operation: request.operation });
      if (url.endsWith('/receipt')) return response(url, committed ? { status: 'revoked', owner: request.owner, session: request.session, operation: request.operation, incarnation: request.incarnation } : { status: 'unconfirmed' }, { status: committed ? 200 : 202 });
      committed = true;
      if (calls.filter(call => !call.url.endsWith('/receipt')).length === 1) throw new Error('response lost');
      return response(url, { status: 'revoked', owner: request.owner, session: request.session, operation: request.operation, incarnation: request.incarnation });
    };
    const transport = createSessionLogoutTransport({ trustedHome: home, fetchImpl });
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: transport.verifyLogoutReceipt });
    await authority.provision();
    const lifecycle = createBrowserAuthLifecycle({ authority, transport: { ...transport, login: async () => ({ kind: 'issued', user: { id: scope.owner, username: 'synthetic' }, session: scope.session, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', logoutCapability: scope.logoutCapability }) } });
    const active = await lifecycle.login(home, {});
    expect(active.status).toBe('active');
    expect((await lifecycle.logout()).status).toBe('logout-unconfirmed');
    expect((await authority.read()).status).toBe('closing');
    expect((await lifecycle.resumeLogout(active.incarnation)).status).toBe('tombstone');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.operation)).size).toBe(1);
    expect(calls[2].url).toBe(`${home}api/auth/session-logout/receipt`);
  });
});
