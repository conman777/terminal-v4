import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserAuthAuthority } from './standaloneIndexedDbAuthAuthority';
import { createBrowserAuthLifecycle } from './browserAuthLifecycle';

const home = 'https://synthetic.example/';
const owner = { id: 'synthetic-owner', username: 'synthetic-user' };
const issue = (session, accessToken, refreshToken) => ({
  kind: 'issued', user: owner, session, accessToken, refreshToken, logoutCapability: 'a'.repeat(64),
});
const successful = issue('session-one', 'access-one', 'refresh-one');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const setup = async () => {
  const indexedDB = new IDBFactory();
  const verifyLogoutReceipt = vi.fn(async value => value.receipt === 'verified-logout');
  const verifyLoginFailureReceipt = vi.fn(async value => value.receipt === 'verified-no-session');
  const authorityA = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt });
  const authorityB = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt });
  expect(await authorityA.provision()).toEqual({ status: 'provisioned' });
  const transport = {
    login: vi.fn(async () => successful),
    recoverLogin: vi.fn(async () => ({ kind: 'no-session', receipt: 'verified-no-session' })),
    refresh: vi.fn(async () => ({ accessToken: 'access-two', refreshToken: 'refresh-two' })),
    logout: vi.fn(async () => 'verified-logout'),
  };
  const notifications = { publish: vi.fn(() => true) };
  const a = createBrowserAuthLifecycle({ authority: authorityA, transport, notifications });
  const b = createBrowserAuthLifecycle({ authority: authorityB, transport, notifications });
  return { a, b, authorityA, authorityB, transport, notifications, verifyLogoutReceipt, verifyLoginFailureReceipt };
};

describe('strict browser auth lifecycle', () => {
  it('claims login before dispatch and publishes the verified owner and credentials together', async () => {
    const { a, authorityA, transport, notifications } = await setup();
    const seen = [];
    transport.login.mockImplementation(async request => {
      seen.push(await authorityA.resumeLogin(request.intent));
      expect(notifications.publish).toHaveBeenCalledTimes(2);
      return successful;
    });
    const result = await a.login(home, { username: 'synthetic-user', password: 'synthetic-password' });
    expect(result.status).toBe('active');
    expect(result).not.toHaveProperty('pair');
    expect(seen).toMatchObject([{ status: 'claimed', home, operationKey: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(await authorityA.read()).toMatchObject({ status: 'active', user: owner, pair: {
      home, owner: owner.id, session: 'session-one', accessToken: 'access-one', refreshToken: 'refresh-one',
    } });
  });

  it('never restores a late refresh after another tab begins logout', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const started = deferred(), response = deferred();
    transport.refresh.mockImplementation(async () => { started.resolve(); return response.promise; });
    const refresh = a.refresh();
    await started.promise;
    expect((await b.logout()).status).toBe('tombstone');
    response.resolve({ accessToken: 'stale-access', refreshToken: 'stale-refresh' });
    expect((await refresh).status).toBe('conflict');
    expect((await authorityA.read()).status).toBe('tombstone');
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain refresh reserved and does not send it twice', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    transport.refresh.mockRejectedValue(new Error('network lost'));
    expect((await a.refresh()).status).toBe('refresh-unconfirmed');
    expect((await b.refresh()).status).toBe('refresh-pending');
    expect(await authorityA.read()).toMatchObject({ status: 'active', refreshReserved: true });
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping refreshes and supports a verified non-rotating response', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const started = deferred(), response = deferred();
    transport.refresh.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const first = a.refresh();
    await started.promise;
    expect((await b.refresh()).status).toBe('refresh-pending');
    response.resolve({ accessToken: 'updated-access', refreshToken: 'refresh-one' });
    expect((await first).status).toBe('active');
    expect(await authorityA.read()).toMatchObject({ status: 'active', refreshReserved: false, pair: { accessToken: 'updated-access', refreshToken: 'refresh-one' } });
    expect((await b.refresh()).status).toBe('active');
    expect(transport.refresh).toHaveBeenCalledTimes(2);
  });

  it('publishes the committed reservation before starting refresh transport', async () => {
    const { a, transport, notifications } = await setup();
    await a.login(home, {});
    notifications.publish.mockClear();
    transport.refresh.mockImplementation(async () => {
      expect(notifications.publish).toHaveBeenCalledTimes(1);
      return { accessToken: 'rotated', refreshToken: 'new-refresh' };
    });
    expect((await a.refresh()).status).toBe('active');
    expect(notifications.publish).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a newer account on behalf of an older request', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const old = await authorityA.read();
    const scope = { incarnation: old.incarnation, owner: old.pair.owner, session: old.pair.session, home: old.pair.home };
    transport.login.mockResolvedValueOnce({ ...issue('session-two', 'access-two', 'refresh-two'), user: { id: 'other-owner', username: 'other' } });
    expect((await b.login(home, {})).status).toBe('retirement-pending');
    expect((await b.recoverRetirements()).status).toBe('active');
    expect((await a.refresh(scope)).status).toBe('conflict');
    expect(transport.refresh).not.toHaveBeenCalled();
  });

  it('does not dispatch a reserved refresh after a new login wins before the final check', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const old = await authorityA.read();
    const scope = { incarnation: old.incarnation, owner: old.pair.owner, session: old.pair.session, home: old.pair.home };
    const entered = deferred(), release = deferred();
    const delayed = { ...authorityA, reserveRefresh: async revision => {
      const result = await authorityA.reserveRefresh(revision);
      entered.resolve(); await release.promise; return result;
    } };
    const awaiting = createBrowserAuthLifecycle({ authority: delayed, transport }).refresh(scope);
    await entered.promise;
    transport.login.mockResolvedValueOnce({ ...issue('session-two', 'access-two', 'refresh-two'), user: { id: 'other-owner', username: 'other' } });
    expect((await b.login(home, {})).status).toBe('retirement-pending');
    expect((await b.recoverRetirements()).status).toBe('active');
    release.resolve();
    expect((await awaiting).status).toBe('conflict');
    expect(transport.refresh).not.toHaveBeenCalled();
  });

  it('releases an undispatched reservation when a new unclaimed login is cancelled', async () => {
    const { a, b, authorityA, authorityB, transport } = await setup();
    await a.login(home, {});
    const entered = deferred(), release = deferred();
    const delayed = { ...authorityA, reserveRefresh: async revision => {
      const result = await authorityA.reserveRefresh(revision);
      entered.resolve(); await release.promise; return result;
    } };
    const refreshing = createBrowserAuthLifecycle({ authority: delayed, transport }).refresh();
    await entered.promise;
    const pending = await authorityB.beginLogin(home);
    release.resolve();
    expect((await refreshing).status).toBe('conflict');
    expect(transport.refresh).not.toHaveBeenCalled();
    expect(await authorityB.cancelUnclaimedLogin(pending.intent)).toEqual({ status: 'cancelled' });
    expect(await authorityA.read()).toMatchObject({ status: 'active', refreshReserved: false });
    expect((await b.refresh()).status).toBe('active');
  });

  it('releases a reservation when aborted before the transport starts', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const delayed = { ...authorityA, reserveRefresh: async revision => {
      const result = await authorityA.reserveRefresh(revision);
      entered.resolve(); await release.promise; return result;
    } };
    const refreshing = createBrowserAuthLifecycle({ authority: delayed, transport }).refresh(undefined, { signal: controller.signal });
    await entered.promise;
    controller.abort(); release.resolve();
    expect((await refreshing).status).toBe('cancelled');
    expect(transport.refresh).not.toHaveBeenCalled();
    expect(await authorityA.read()).toMatchObject({ status: 'active', refreshReserved: false });
    expect((await b.refresh()).status).toBe('active');
  });

  it('retains the reservation when cancellation happens after transport dispatch', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const entered = deferred(), controller = new AbortController();
    transport.refresh.mockImplementation(({ signal }) => new Promise((_, reject) => {
      entered.resolve(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const refreshing = a.refresh(undefined, { signal: controller.signal });
    await entered.promise; controller.abort();
    expect((await refreshing).status).toBe('refresh-unconfirmed');
    expect(await authorityA.read()).toMatchObject({ status: 'active', refreshReserved: true });
    expect((await b.refresh()).status).toBe('refresh-pending');
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it('requires verified session-scoped logout and retains the exact operation for retry', async () => {
    const { a, b, authorityA, transport, verifyLogoutReceipt } = await setup();
    await a.login(home, {});
    transport.logout.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce('verified-logout');
    const failed = await a.logout();
    expect(failed.status).toBe('logout-unconfirmed');
    expect((await authorityA.read()).status).toBe('closing');
    expect((await b.resumeLogout(failed.incarnation)).status).toBe('tombstone');
    expect(transport.logout.mock.calls[1][0]).toEqual(transport.logout.mock.calls[0][0]);
    expect(verifyLogoutReceipt).toHaveBeenCalledWith(expect.objectContaining({ receipt: 'verified-logout', owner: owner.id, session: 'session-one', home }));
  });

  it('keeps logout closed when a received receipt is not verified', async () => {
    const { a, b, authorityA, transport } = await setup();
    const active = await a.login(home, {});
    transport.logout.mockResolvedValueOnce('unverified');
    expect((await a.logout()).status).toBe('unconfirmed');
    expect((await authorityA.read()).status).toBe('closing');
    expect((await b.resumeLogout(active.incarnation)).status).toBe('tombstone');
  });

  it('does not release an uncertain login without an independently verified receipt', async () => {
    const { a, b, authorityA, transport } = await setup();
    transport.login.mockRejectedValue(new Error('lost response'));
    const result = await a.login(home, {});
    expect(result.status).toBe('login-unconfirmed');
    expect((await authorityA.read()).status).toBe('login-recovery-pending');
    expect(await b.pendingLogins()).toEqual({ status: 'pending', logins: [{ intent: result.intent, home, state: 'claimed' }] });
    transport.recoverLogin.mockResolvedValueOnce({ kind: 'no-session', receipt: 'not-verified' });
    expect((await b.recoverLogin(result.intent)).status).toBe('unconfirmed');
    expect((await authorityA.read()).status).toBe('login-recovery-pending');
    expect((await b.recoverLogin(result.intent)).status).toBe('no-session');
    expect((await authorityA.read()).status).toBe('tombstone');
  });

  it('retains the login intent when claiming may have committed without confirmation', async () => {
    const { authorityA, transport } = await setup();
    const uncertain = { ...authorityA, claimLogin: async intent => { await authorityA.claimLogin(intent); return { status: 'unavailable' }; } };
    const lifecycle = createBrowserAuthLifecycle({ authority: uncertain, transport });
    const result = await lifecycle.login(home, {});
    expect(result).toMatchObject({ status: 'login-unconfirmed', intent: expect.any(String) });
    expect(transport.login).not.toHaveBeenCalled();
    expect((await lifecycle.recoverLogin(result.intent)).status).toBe('no-session');
  });

  it('quarantines a late superseded login and withholds the new one until retirement', async () => {
    const { a, b, authorityA, transport } = await setup();
    const started = deferred(), response = deferred();
    transport.login.mockImplementationOnce(async () => { started.resolve(); return response.promise; })
      .mockResolvedValueOnce(issue('session-two', 'access-two', 'refresh-two'));
    const older = a.login(home, {});
    await started.promise;
    expect((await b.login(home, {})).status).toBe('login-recovery-pending');
    response.resolve(successful);
    expect((await older).status).toBe('retirement-pending');
    expect((await authorityA.read()).status).toBe('retirement-pending');
    expect((await b.recoverRetirements()).status).toBe('active');
    expect((await authorityA.read()).pair).toMatchObject({ session: 'session-two', accessToken: 'access-two' });
  });

  it('lets sign-out fence an in-flight replacement login without restoring either session', async () => {
    const { a, b, authorityA, transport } = await setup();
    await a.login(home, {});
    const started = deferred(), response = deferred();
    transport.login.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const pending = a.login(home, {});
    await started.promise;
    expect((await b.logout()).status).toBe('login-recovery-pending');
    response.resolve(issue('session-two', 'access-two', 'refresh-two'));
    expect((await pending).status).toBe('retirement-pending');
    expect((await b.recoverRetirements()).status).toBe('tombstone');
    expect((await authorityA.read()).status).toBe('tombstone');
  });

  it('never alters account-scoped legacy draft storage during auth transitions', async () => {
    const { a, transport } = await setup();
    const key = 'identity:https%3A%2F%2Fsynthetic.example%2F:synthetic-owner:composerDraft:v1:fixture';
    const draft = JSON.stringify({ text: 'Unsent synthetic draft', pending: { requestId: 'draft-intent' } });
    localStorage.setItem(key, draft);
    try {
      await a.login(home, {});
      transport.refresh.mockRejectedValueOnce(new Error('offline'));
      await a.refresh();
      await a.logout();
      expect(localStorage.getItem(key)).toBe(draft);
    } finally { localStorage.removeItem(key); }
  });
});
