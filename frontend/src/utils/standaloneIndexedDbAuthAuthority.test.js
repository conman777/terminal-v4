import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserAuthAuthority, createStandaloneIndexedDbAuthAuthority } from './standaloneIndexedDbAuthAuthority';

const pair = (n, session = 'session-1') => ({ session, accessToken: `access-${n}`, refreshToken: `refresh-${n}`, owner: 'owner-1', home: 'https://home.example/' });
const receipt = 'synthetic-server-complete';
const verifyLogoutReceipt = async value => value.receipt === receipt;
const setup = async () => {
  const indexedDB = new IDBFactory();
  const a = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt });
  const b = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt });
  expect(await a.provision()).toEqual({ status: 'provisioned' });
  return { a, b, indexedDB };
};
const completeSyntheticLogout = async (authority, incarnation) => {
  const started = await authority.beginLogout(incarnation);
  expect(started.status).toBe('started');
  return authority.finishLogout(started.revision, incarnation, started.operation, receipt);
};
const profileLogin = async (authority, value, user) => {
  const pending = await authority.beginLogin(value.home);
  expect(pending.status).toBe('login-pending');
  expect((await authority.claimLogin(pending.intent)).status).toBe('claimed');
  return authority.loginWithUser(pending.intent, value, user);
};

describe('standalone IndexedDB auth authority', () => {
  it('releases only the exact undispatched strict reservation while preserving a newer login intent', async () => {
    const indexedDB = new IDBFactory();
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await a.provision();
    const login = await profileLogin(a, { ...pair(1), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    const reserved = await a.reserveRefresh(login.revision);
    const pending = await b.beginLogin(pair(2).home);
    expect(await b.releaseUndispatchedRefresh(reserved.revision, 'foreign-incarnation', reserved.reservation)).toEqual({ status: 'conflict' });
    expect(await b.releaseUndispatchedRefresh(reserved.revision, reserved.incarnation, 'foreign-reservation')).toEqual({ status: 'conflict' });
    expect(await a.releaseUndispatchedRefresh(reserved.revision, reserved.incarnation, reserved.reservation)).toEqual({ status: 'released' });
    expect(await a.releaseUndispatchedRefresh(reserved.revision, reserved.incarnation, reserved.reservation)).toEqual({ status: 'conflict' });
    expect(await b.cancelUnclaimedLogin(pending.intent)).toEqual({ status: 'cancelled' });
    const current = await b.read();
    expect(current).toMatchObject({ status: 'active', incarnation: login.incarnation, refreshReserved: false, pair: { refreshToken: 'refresh-1' } });
    expect((await b.reserveRefresh(current.revision)).status).toBe('reserved');
  });
  it('holds a newer login until a superseded dispatched login has been retired', async () => {
    const indexedDB = new IDBFactory();
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await a.provision();
    const old = await a.beginLogin('https://home.example/');
    const oldClaim = await a.claimLogin(old.intent);
    expect(oldClaim).toMatchObject({ status: 'claimed', intent: old.intent, home: 'https://home.example/' });
    expect(oldClaim.operationKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await b.claimLogin(old.intent)).toEqual({ status: 'already-claimed' });
    const fresh = await b.beginLogin('https://home.example/');
    expect((await b.claimLogin(fresh.intent)).status).toBe('claimed');
    const newPair = { ...pair(2, 'session-2'), owner: 'owner-2', logoutCapability: 'b'.repeat(64) };
    const waiting = await b.loginWithUser(fresh.intent, newPair, { id: 'owner-2', username: 'new' });
    expect(waiting.status).toBe('login-recovery-pending');
    const visible = await a.read();
    expect(JSON.stringify(visible)).not.toContain(newPair.accessToken);
    expect(JSON.stringify(visible)).not.toContain(oldClaim.operationKey);
    expect(await b.pendingLogins()).toMatchObject({ status: 'pending', logins: [{ intent: old.intent, state: 'unresolved' }] });
    expect(await b.resumeLogin(old.intent)).toMatchObject({ status: 'unresolved', operationKey: oldClaim.operationKey });
    const oldPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    expect((await a.loginWithUser(old.intent, oldPair, null)).status).toBe('retirement-pending');
    const retirement = (await b.pendingRetirements()).retirements[0];
    expect(retirement).toMatchObject({ session: oldPair.session, owner: oldPair.owner, logoutCapability: oldPair.logoutCapability });
    expect(await b.completeRetirement(retirement.incarnation, retirement.operation, receipt)).toEqual({ status: 'retired' });
    const active = await b.read();
    expect(active).toMatchObject({ status: 'active', pair: { session: newPair.session, owner: newPair.owner }, user: { id: 'owner-2', username: 'new' } });
    const closing = await b.beginLogout(active.incarnation, active.controlRevision);
    await b.finishLogout(closing.revision, closing.incarnation, closing.operation, receipt);
    const retry = await b.beginLogin(oldPair.home);
    await b.claimLogin(retry.intent);
    expect(await b.loginWithUser(retry.intent, { ...oldPair, session: 'session-3', logoutCapability: 'c'.repeat(64) }, { id: 'owner-1', username: 'old' })).toEqual({ status: 'conflict' });
  });

  it('quarantines a dispatched login response arriving after sign-out', async () => {
    const indexedDB = new IDBFactory();
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await a.provision();
    const intent = await a.beginLogin('https://home.example/');
    await a.claimLogin(intent.intent);
    const scope = await a.read();
    expect((await a.logout(scope.revision)).status).toBe('login-recovery-pending');
    const rejectedPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    expect((await a.loginWithUser(intent.intent, rejectedPair, { id: 'owner-1', username: 'fixture' })).status).toBe('retirement-pending');
    const retirement = (await a.pendingRetirements()).retirements[0];
    expect(await a.completeRetirement(retirement.incarnation, retirement.operation, receipt)).toEqual({ status: 'retired' });
    expect((await a.read()).status).toBe('tombstone');
  });

  it('does not expose refresh credentials if a new login is claimed during digest preparation', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    const login = await profileLogin(authority, { ...pair(1), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    try {
      const refreshing = authority.reserveRefresh(login.revision);
      await waiting;
      const intent = await authority.beginLogin(pair(2).home);
      expect((await authority.claimLogin(intent.intent)).status).toBe('claimed');
      release();
      expect(await refreshing).toEqual({ status: 'conflict' });
      expect((await authority.read()).status).toBe('login-recovery-pending');
    } finally { release(); spy.mockRestore(); }
  });

  it.each(['signed-out', 'active'])('does not claim a login when doing so would prevent %s logout from archiving it', async state => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    if (state === 'active') await profileLogin(authority, { ...pair(0), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    for (let index = 0; index < 64; index += 1) {
      const pending = await authority.beginLogin('https://home.example/');
      expect((await authority.claimLogin(pending.intent)).status).toBe('claimed');
    }
    const final = await authority.beginLogin('https://home.example/');
    expect(await authority.claimLogin(final.intent)).toEqual({ status: 'conflict' });
    const scope = await authority.read();
    if (state === 'active') {
      const closing = await authority.beginLogout(scope.incarnation, scope.controlRevision);
      expect(closing.status).toBe('started');
      expect((await authority.finishLogout(closing.revision, closing.incarnation, closing.operation, receipt)).status).toBe('login-recovery-pending');
    } else expect((await authority.logout(scope.revision)).status).toBe('login-recovery-pending');
    expect((await authority.pendingLogins()).logins).toHaveLength(64);
  });

  it('clears a failed login only after independently verifying an exact no-session receipt', async () => {
    const indexedDB = new IDBFactory();
    const verifier = vi.fn(async value => value.receipt === 'synthetic-no-session');
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt: verifier });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt: verifier });
    await a.provision();
    const old = await a.beginLogin('https://home.example/');
    const oldClaim = await a.claimLogin(old.intent);
    const fresh = await b.beginLogin('https://home.example/');
    await b.claimLogin(fresh.intent);
    const next = await b.loginWithUser(fresh.intent, { ...pair(2), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    expect(next.status).toBe('login-recovery-pending');
    expect(await a.completeLoginFailure(old.intent, 'unconfirmed')).toEqual({ status: 'unconfirmed' });
    expect((await b.read()).status).toBe('login-recovery-pending');
    expect(await a.completeLoginFailure(old.intent, 'synthetic-no-session')).toEqual({ status: 'no-session' });
    expect((await b.read()).status).toBe('active');
    expect(verifier).toHaveBeenLastCalledWith({ intent: old.intent, home: oldClaim.home, operationKey: oldClaim.operationKey, receipt: 'synthetic-no-session' });
    expect(await a.completeLoginFailure(old.intent, 'synthetic-no-session')).toEqual({ status: 'conflict' });
  });

  it('rechecks the same no-session proof when its login becomes superseded during verification', async () => {
    const indexedDB = new IDBFactory();
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    const verifier = async () => { entered(); await gate; return true; };
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt: verifier });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt: verifier });
    await a.provision();
    const old = await a.beginLogin('https://home.example/');
    await a.claimLogin(old.intent);
    const resolving = a.completeLoginFailure(old.intent, 'synthetic-no-session');
    await waiting;
    const fresh = await b.beginLogin('https://home.example/');
    await b.claimLogin(fresh.intent);
    release();
    expect(await resolving).toEqual({ status: 'no-session' });
    expect(await b.pendingLogins()).toMatchObject({ logins: [{ intent: fresh.intent, state: 'claimed' }] });
    const current = await b.loginWithUser(fresh.intent, { ...pair(2), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    expect(current.status).toBe('active');
  });

  it('can cancel an unclaimed login but cannot locally discard a dispatched one', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    const unused = await authority.beginLogin('https://home.example/');
    expect(await authority.cancelUnclaimedLogin(unused.intent)).toEqual({ status: 'cancelled' });
    expect(await authority.claimLogin(unused.intent)).toEqual({ status: 'conflict' });
    const dispatched = await authority.beginLogin('https://home.example/');
    await authority.claimLogin(dispatched.intent);
    expect(await authority.cancelUnclaimedLogin(dispatched.intent)).toEqual({ status: 'conflict' });
    expect(await authority.completeLoginFailure(dispatched.intent, 'unverified')).toEqual({ status: 'unavailable' });
    expect((await authority.read()).status).toBe('login-recovery-pending');
  });

  it.each(['claimed', 'unresolved'])('fails closed if the persisted %s login proof disappears', async mode => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    const intent = await authority.beginLogin('https://home.example/');
    await authority.claimLogin(intent.intent);
    if (mode === 'unresolved') await authority.beginLogin('https://home.example/');
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-browser-auth-authority-v2', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('history');
      request.onsuccess = () => { delete request.result[mode === 'claimed' ? 'loginIntent' : 'unresolvedLogins']; store.put(request.result, 'history'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await authority.read()).toEqual({ status: 'unavailable' });
    expect(await authority.pendingLogins()).toEqual({ status: 'unavailable' });
  });
  it('keeps the browser authority in a separate database and exposes only strict login and refresh operations', async () => {
    const indexedDB = new IDBFactory();
    const legacy = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const strict = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await legacy.provision();
    await legacy.login((await legacy.read()).revision, pair(1));
    expect(await strict.read()).toEqual({ status: 'unavailable' });
    expect(await strict.provision()).toEqual({ status: 'provisioned' });
    expect(strict.login).toBeUndefined();
    expect(strict.compareAndSet).toBeUndefined();
    const intent = await strict.beginLogin(pair(2).home);
    expect(await strict.loginWithUser(intent.intent, pair(2), { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'invalid' });
    expect((await strict.claimLogin(intent.intent)).status).toBe('claimed');
    const strictPair = { ...pair(2), logoutCapability: 'a'.repeat(64) };
    const current = await strict.loginWithUser(intent.intent, strictPair, { id: 'owner-1', username: 'fixture' });
    expect(await strict.read()).toEqual(current);
    expect((await legacy.read()).pair).toEqual(pair(1));
  });

  it('recovers an exact pending strict logout without exposing its capability to ordinary reads', async () => {
    const indexedDB = new IDBFactory();
    const verifier = vi.fn(async value => value.receipt === receipt);
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: verifier });
    await a.provision();
    const strictPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    const login = await profileLogin(a, strictPair, { id: 'owner-1', username: 'fixture' });
    const started = await a.beginLogout(login.incarnation, login.controlRevision);
    const reopened = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: verifier });
    const visible = await reopened.read();
    expect(JSON.stringify(visible)).not.toContain(strictPair.logoutCapability);
    const resumed = await reopened.resumeLogout(login.incarnation);
    expect(resumed).toMatchObject({ status: 'started', incarnation: login.incarnation, operation: started.operation, logoutCapability: strictPair.logoutCapability, session: strictPair.session, owner: strictPair.owner, home: strictPair.home });
    expect(await reopened.resumeLogout('wrong-incarnation')).toEqual({ status: 'conflict' });
    expect((await reopened.finishLogout(resumed.revision, resumed.incarnation, resumed.operation, receipt)).status).toBe('tombstone');
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ incarnation: login.incarnation, operation: started.operation, session: strictPair.session, owner: strictPair.owner, home: strictPair.home, logoutCapability: strictPair.logoutCapability, receipt }));
  });

  it('keeps the logout capability private and bound across token refresh', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    const intent = await authority.beginLogin(pair(1).home);
    for (const logoutCapability of ['', 'A'.repeat(64), 'a'.repeat(63), 'z'.repeat(64)]) {
      expect(await authority.loginWithUser(intent.intent, { ...pair(1), logoutCapability }, { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'invalid' });
    }
    const secret = 'a'.repeat(64);
    expect((await authority.claimLogin(intent.intent)).status).toBe('claimed');
    const login = await authority.loginWithUser(intent.intent, { ...pair(1), logoutCapability: secret }, { id: 'owner-1', username: 'fixture' });
    expect(JSON.stringify(login)).not.toContain(secret);
    const reserved = await authority.reserveRefresh(login.revision);
    expect(JSON.stringify(reserved)).not.toContain(secret);
    expect(await authority.completeRefresh(reserved.revision, reserved.reservation, { ...pair(2), logoutCapability: 'b'.repeat(64) })).toEqual({ status: 'conflict' });
    const completed = await authority.completeRefresh(reserved.revision, reserved.reservation, pair(2));
    expect(completed.pair).toEqual(pair(2));
    const closing = await authority.beginLogout(completed.incarnation, completed.controlRevision);
    expect(closing.logoutCapability).toBe(secret);
    await authority.finishLogout(closing.revision, closing.incarnation, closing.operation, receipt);
    const retry = await authority.beginLogin(pair(2).home);
    await authority.claimLogin(retry.intent);
    expect(await authority.loginWithUser(retry.intent, { ...pair(2, 'new-session'), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'conflict' });
  });

  it('does not finish a strict logout if the capability changes during verification', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-browser-auth-authority-v2', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('authority', 'readwrite');
        const store = tx.objectStore('authority');
        const request = store.get('current');
        request.onsuccess = () => { request.result.pair.logoutCapability = 'b'.repeat(64); store.put(request.result, 'current'); };
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    } });
    await authority.provision();
    const login = await profileLogin(authority, { ...pair(1), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'fixture' });
    const started = await authority.beginLogout(login.incarnation, login.controlRevision);
    expect(await authority.finishLogout(started.revision, started.incarnation, started.operation, receipt)).toEqual({ status: 'conflict' });
    expect((await authority.read()).status).toBe('closing');
  });

  it('holds a replacement login until the prior server session is confirmed retired', async () => {
    const indexedDB = new IDBFactory();
    const verifier = vi.fn(async value => value.receipt === receipt);
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: verifier });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: verifier });
    await a.provision();
    const oldPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    const old = await profileLogin(a, oldPair, { id: 'owner-1', username: 'old' });
    const reserved = await a.reserveRefresh(old.revision);
    const nextPair = { ...pair(2, 'session-2'), owner: 'owner-2', logoutCapability: 'b'.repeat(64) };
    const next = await profileLogin(b, nextPair, { id: 'owner-2', username: 'new' });
    expect(next.status).toBe('retirement-pending');
    expect(JSON.stringify(next)).not.toContain(nextPair.accessToken);
    expect(await a.read()).toEqual(next);
    expect(await b.beginLogin(nextPair.home)).toEqual({ status: 'conflict' });
    expect(await b.beginLogout(next.incarnation, next.controlRevision)).toEqual({ status: 'conflict' });
    expect(await b.resumeLogout(next.incarnation)).toEqual({ status: 'conflict' });
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, pair(3))).toEqual({ status: 'conflict' });
    const pending = await a.pendingRetirements();
    expect(pending).toMatchObject({ status: 'pending', retirements: [{ incarnation: old.incarnation, session: oldPair.session, owner: oldPair.owner, home: oldPair.home, logoutCapability: oldPair.logoutCapability }] });
    const retirement = pending.retirements[0];
    expect(await b.completeRetirement(retirement.incarnation, retirement.operation, 'pending')).toEqual({ status: 'unconfirmed' });
    expect((await b.read()).status).toBe('retirement-pending');
    expect(await b.completeRetirement(retirement.incarnation, retirement.operation, receipt)).toEqual({ status: 'retired' });
    expect(await b.read()).toMatchObject({ status: 'active', pair: { session: nextPair.session, owner: nextPair.owner, accessToken: nextPair.accessToken }, user: { id: nextPair.owner, username: 'new' } });
    expect(verifier).toHaveBeenLastCalledWith(expect.objectContaining({ incarnation: old.incarnation, operation: retirement.operation, session: oldPair.session, owner: oldPair.owner, home: oldPair.home, logoutCapability: oldPair.logoutCapability, receipt }));
  });

  it('does not let an older logout cancel a newer active-session login intent', async () => {
    const indexedDB = new IDBFactory();
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await a.provision();
    const oldPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    const login = await profileLogin(a, oldPair, { id: 'owner-1', username: 'old' });
    const pending = await b.beginLogin(pair(2).home);
    expect(await a.beginLogout(login.incarnation, login.controlRevision)).toEqual({ status: 'conflict' });
    expect((await b.claimLogin(pending.intent)).status).toBe('claimed');
    const next = await b.loginWithUser(pending.intent, { ...pair(2, 'session-2'), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'new' });
    expect(next.status).toBe('retirement-pending');
  });

  it('fails closed if a pending retirement is removed from history', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    await profileLogin(authority, { ...pair(1), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'old' });
    await profileLogin(authority, { ...pair(2, 'session-2'), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'new' });
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-browser-auth-authority-v2', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('history');
      request.onsuccess = () => { delete request.result.retirements; store.put(request.result, 'history'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await authority.read()).toEqual({ status: 'unavailable' });
    expect(await authority.pendingRetirements()).toEqual({ status: 'unavailable' });
  });

  it('fails closed if a pending retirement targets the replacement session', async () => {
    const indexedDB = new IDBFactory();
    const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await authority.provision();
    const oldPair = { ...pair(1), logoutCapability: 'a'.repeat(64) };
    const newPair = { ...pair(2, 'session-2'), logoutCapability: 'b'.repeat(64) };
    await profileLogin(authority, oldPair, { id: 'owner-1', username: 'old' });
    await profileLogin(authority, newPair, { id: 'owner-1', username: 'new' });
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-browser-auth-authority-v2', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('history');
      request.onsuccess = () => { request.result.retirements[0].session = newPair.session; store.put(request.result, 'history'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await authority.read()).toEqual({ status: 'unavailable' });
    expect(await authority.pendingRetirements()).toEqual({ status: 'unavailable' });
  });

  it('commits a retirement only once when two tabs verify the same receipt', async () => {
    const indexedDB = new IDBFactory();
    const a = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const b = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt });
    await a.provision();
    await profileLogin(a, { ...pair(1), logoutCapability: 'a'.repeat(64) }, { id: 'owner-1', username: 'old' });
    await profileLogin(b, { ...pair(2, 'session-2'), logoutCapability: 'b'.repeat(64) }, { id: 'owner-1', username: 'new' });
    const retirement = (await a.pendingRetirements()).retirements[0];
    const results = await Promise.all([a.completeRetirement(retirement.incarnation, retirement.operation, receipt), b.completeRetirement(retirement.incarnation, retirement.operation, receipt)]);
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'retired']);
    expect((await a.read()).status).toBe('active');
    expect(await b.pendingRetirements()).toEqual({ status: 'pending', retirements: [] });
  });
  it('commits only the latest sign-in intent across tabs', async () => {
    const { a, b } = await setup();
    const first = await a.beginLogin('https://home.example/');
    const second = await b.beginLogin('https://home.example/');
    expect(first.status).toBe('login-pending');
    expect(second.status).toBe('login-pending');
    const newPair = { ...pair(2), owner: 'other-owner' };
    const current = await b.loginWithUser(second.intent, newPair, { id: 'other-owner', username: 'new-user' });
    expect(current).toMatchObject({ status: 'active', pair: newPair, user: { id: 'other-owner', username: 'new-user' } });
    expect(await a.loginWithUser(first.intent, pair(1), { id: 'owner-1', username: 'old-user' })).toEqual({ status: 'conflict' });
    expect(await a.readWithUser()).toEqual(current);
  });

  it('cancels an in-flight sign-in when the current session begins logout', async () => {
    const { a, b } = await setup();
    const loginIntent = await a.beginLogin('https://home.example/');
    const login = await a.loginWithUser(loginIntent.intent, pair(1), { id: 'owner-1', username: 'fixture' });
    const pending = await b.beginLogin('https://home.example/');
    const closing = await a.beginLogout(login.incarnation);
    expect(closing.status).toBe('started');
    const tombstone = await a.finishLogout(closing.revision, closing.incarnation, closing.operation, receipt);
    expect(await b.loginWithUser(pending.intent, pair(2), { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'conflict' });
    expect(await a.readWithUser()).toEqual(tombstone);
  });

  it('invalidates a pending sign-in even if the account was already signed out', async () => {
    const { a, b } = await setup();
    const pending = await a.beginLogin('https://home.example/');
    const tombstone = await b.logout((await b.read()).revision);
    expect(await a.loginWithUser(pending.intent, pair(1), { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'conflict' });
    expect(await a.readWithUser()).toEqual(tombstone);
  });

  it('does not let a stale signed-out revision cancel a newer sign-in intent', async () => {
    const { a, b } = await setup();
    const stale = await a.read();
    const pending = await b.beginLogin('https://home.example/');
    expect(await a.logout(stale.revision)).toEqual({ status: 'conflict' });
    const current = await b.loginWithUser(pending.intent, pair(1), { id: 'owner-1', username: 'fixture' });
    expect(current).toMatchObject({ status: 'active', pair: pair(1) });
  });

  it('does not let a stale logout cancel a newer sign-in intent', async () => {
    const { a, b } = await setup();
    const first = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const next = await a.beginLogin(pair(2).home);
    expect(await b.beginLogout('old-incarnation')).toEqual({ status: 'conflict' });
    const current = await a.loginWithUser(next.intent, pair(2), { id: 'owner-1', username: 'fixture' });
    expect(current).toMatchObject({ status: 'active', pair: pair(2) });
    expect(current.incarnation).not.toBe(first.incarnation);
  });

  it('preserves uncertain refresh history when a newer sign-in commits', async () => {
    const { a, b } = await setup();
    const first = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const reserved = await a.reserveRefresh(first.revision);
    const next = await b.beginLogin(pair(2).home);
    const current = await b.loginWithUser(next.intent, pair(2), { id: 'owner-1', username: 'fixture' });
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, pair(3))).toEqual({ status: 'conflict' });
    expect(await b.compareAndSet(current.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await b.readWithUser()).toEqual(current);
  });

  it('does not let a sign-in intent change its chosen home', async () => {
    const { a } = await setup();
    const pending = await a.beginLogin('https://home.example/');
    expect(await a.loginWithUser(pending.intent, { ...pair(1), home: 'https://other.example/' }, { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'conflict' });
    expect((await a.loginWithUser(pending.intent, pair(1), { id: 'owner-1', username: 'fixture' })).status).toBe('active');
  });
  it('commits the complete user profile with its credentials and keeps it through refresh', async () => {
    const { a, b } = await setup();
    const user = { id: 'owner-1', username: 'fixture', created_at: '2026-01-01', preferences: { theme: 'dark' } };
    const intent = await a.beginLogin(pair(1).home);
    const pending = a.loginWithUser(intent.intent, pair(1), user);
    user.preferences.theme = 'light';
    const login = await pending;
    expect(login).toMatchObject({ status: 'active', pair: pair(1), user: { ...user, preferences: { theme: 'dark' } } });
    const reserved = await b.reserveRefresh(login.revision);
    expect(reserved.user).toEqual({ id: 'owner-1', username: 'fixture', created_at: '2026-01-01', preferences: { theme: 'dark' } });
    const completed = await a.completeRefresh(reserved.revision, reserved.reservation, pair(2));
    expect(await b.readWithUser()).toEqual(completed);
    expect(completed.user.preferences.theme).toBe('dark');
  });

  it('rejects a mismatched or malformed profile and a missing profile on strict reads', async () => {
    const { a } = await setup();
    const intent = await a.beginLogin(pair(1).home);
    const initial = await a.read();
    for (const user of [{ id: 'other', username: 'fixture' }, { id: 'owner-1', username: '' }, { id: 'owner-1', username: 'x'.repeat(1025) }, null]) {
      expect(await a.loginWithUser(intent.intent, pair(1), user)).toEqual({ status: 'invalid' });
      expect(await a.read()).toEqual(initial);
    }
    const throwing = { id: 'owner-1', get username() { throw new Error('unreadable'); } };
    expect(await a.loginWithUser(intent.intent, pair(1), throwing)).toEqual({ status: 'invalid' });
    expect(await a.read()).toEqual(initial);
    const legacy = (await setup()).a;
    await legacy.login((await legacy.read()).revision, pair(1));
    expect(await legacy.readWithUser()).toEqual({ status: 'unavailable' });
  });

  it('fails closed if a stored profile is no longer bound to its owner', async () => {
    const { a, indexedDB } = await setup();
    await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('current');
      request.onsuccess = () => { request.result.user.id = 'foreign-owner'; store.put(request.result, 'current'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await a.readWithUser()).toEqual({ status: 'unavailable' });
    expect(await a.read()).toEqual({ status: 'unavailable' });
  });

  it.each(['user', 'marker'])('fails closed when the profile-bound %s is removed from an active session', async missing => {
    const { a, indexedDB } = await setup();
    await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const key = missing === 'user' ? 'current' : 'history';
      const request = store.get(key);
      request.onsuccess = () => { delete request.result[missing === 'user' ? 'user' : 'profileRequired']; store.put(request.result, key); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await a.readWithUser()).toEqual({ status: 'unavailable' });
  });

  it('does not install a credential with an uncertain refresh history in a new login', async () => {
    const { a } = await setup();
    const login = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    await a.reserveRefresh(login.revision);
    await completeSyntheticLogout(a, login.incarnation);
    const intent = await a.beginLogin(pair(1).home);
    const pending = await a.read();
    expect(await a.loginWithUser(intent.intent, pair(1), { id: 'owner-1', username: 'fixture' })).toEqual({ status: 'conflict' });
    expect(await a.login(pending.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(pending);
  });

  it('does not downgrade a profile-bound authority to the legacy profile-free login', async () => {
    const { a } = await setup();
    const login = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const tombstone = await completeSyntheticLogout(a, login.incarnation);
    expect(await a.login(tombstone.revision, pair(2))).toEqual({ status: 'conflict' });
    expect(await a.readWithUser()).toEqual(tombstone);
    expect((await profileLogin(a, pair(2), { id: 'owner-1', username: 'fixture' })).status).toBe('active');
  });

  it('rejects previously spent tokens in both pair replacement and refresh completion', async () => {
    const { a } = await setup();
    const old = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    await a.reserveRefresh(old.revision);
    const tombstone = await completeSyntheticLogout(a, old.incarnation);
    const current = await profileLogin(a, pair(2), { id: 'owner-1', username: 'fixture' });
    expect(await a.compareAndSet(current.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.compareAndSet(current.revision, pair(3))).toEqual({ status: 'conflict' });
    const reserved = await a.reserveRefresh(current.revision);
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.readWithUser()).toMatchObject({ pair: pair(2), refreshReserved: true });
  });

  it('fails closed if a stored active refresh token is already marked as spent', async () => {
    const { a, indexedDB } = await setup();
    await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture' });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair(1).refreshToken));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('history');
      request.onsuccess = () => { request.result.entries.push({ fingerprint, reservation: 'old-reservation' }); store.put(request.result, 'history'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await a.readWithUser()).toEqual({ status: 'unavailable' });
  });

  it('merges profile-only updates without changing the owner or an in-flight refresh', async () => {
    const { a } = await setup();
    const login = await profileLogin(a, pair(1), { id: 'owner-1', username: 'fixture', created_at: '2026-01-01' });
    expect(await a.updateUser(login.revision, { id: 'other', username: 'changed' })).toEqual({ status: 'invalid' });
    const updated = await a.updateUser(login.revision, { id: 'owner-1', username: 'changed' });
    expect(updated.user).toEqual({ id: 'owner-1', username: 'changed', created_at: '2026-01-01' });
    const reserved = await a.reserveRefresh(updated.revision);
    expect(await a.updateUser(reserved.revision, { id: 'owner-1', username: 'later' })).toEqual({ status: 'conflict' });
    expect((await a.completeRefresh(reserved.revision, reserved.reservation, pair(2))).user).toEqual(updated.user);
  });

  it('binds refresh and updates to the authenticated account and home server', async () => {
    const { a } = await setup();
    const initial = await a.read();
    const scoped = { ...pair(1), owner: 'owner-1', home: 'https://home.example/' };
    const login = await a.login(initial.revision, scoped);
    expect(login).toMatchObject({ status: 'active', pair: scoped });
    expect(await a.compareAndSet(login.revision, { ...scoped, owner: 'owner-2' })).toEqual({ status: 'conflict' });
    expect(await a.compareAndSet(login.revision, { ...scoped, home: 'https://other.example/' })).toEqual({ status: 'conflict' });
    const reserved = await a.reserveRefresh(login.revision);
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, { ...scoped, owner: 'owner-2' })).toEqual({ status: 'conflict' });
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, { ...scoped, home: 'https://other.example/' })).toEqual({ status: 'conflict' });
    expect(await a.read()).toMatchObject({ status: 'active', pair: scoped, refreshReserved: true });
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, { ...scoped, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' })).toMatchObject({ status: 'active' });
  });

  it.each([
    { owner: '' }, { owner: 'owner\nother' }, { owner: 'x'.repeat(257) },
    { session: 'session\nother' }, { session: 'x'.repeat(257) },
    { home: 'javascript:alert(1)' }, { home: 'https://user:secret@home.example/' },
    { home: 'https://home.example/?other=1' }, { home: 'https://home.example/#other' },
    { home: 'https://HOME.example/' },
  ])('rejects invalid authority scope %o without changing the record', async invalidScope => {
    const { a } = await setup();
    const initial = await a.read();
    expect(await a.login(initial.revision, { ...pair(1), ...invalidScope })).toEqual({ status: 'invalid' });
    expect(await a.read()).toEqual(initial);
  });

  it('fails closed on an older active record without an account or server binding', async () => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    await a.login(initial.revision, pair(1));
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('authority', 'readwrite');
      const store = tx.objectStore('authority');
      const request = store.get('current');
      request.onsuccess = () => { delete request.result.pair.owner; delete request.result.pair.home; store.put(request.result, 'current'); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await a.read()).toEqual({ status: 'unavailable' });
    expect(await a.login(initial.revision, pair(1))).toEqual({ status: 'unavailable' });
  });

  it.each(['session', 'owner', 'home'])('does not finish logout if the stored %s changes during receipt verification', async field => {
    const indexedDB = new IDBFactory();
    const altered = field === 'home' ? 'https://other.example/' : `other-${field}`;
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt: async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('authority', 'readwrite');
        const store = tx.objectStore('authority');
        const request = store.get('current');
        request.onsuccess = () => { request.result.pair[field] = altered; store.put(request.result, 'current'); };
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    } });
    await authority.provision();
    const login = await authority.login((await authority.read()).revision, pair(1));
    const started = await authority.beginLogout(login.incarnation);
    expect(await authority.finishLogout(started.revision, started.incarnation, started.operation, receipt)).toEqual({ status: 'conflict' });
    expect(await authority.read()).toMatchObject({ status: 'closing', revision: started.revision });
  });
  it('does not create a missing authority while reading', async () => {
    const indexedDB = new IDBFactory();
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    expect(await authority.read()).toEqual({ status: 'unavailable' });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('provisions once without resetting an existing authority', async () => {
    const indexedDB = new IDBFactory();
    const a = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    const b = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    const outcomes = await Promise.all([a.provision(), b.provision()]);
    expect(outcomes.map(value => value.status).sort()).toEqual(['existing', 'provisioned']);
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    expect(await b.provision()).toEqual({ status: 'existing' });
    expect(await b.read()).toEqual(login);
  });

  it('does not recreate history after an uncertain refresh database is deleted', async () => {
    const indexedDB = new IDBFactory();
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    expect(await authority.provision()).toEqual({ status: 'provisioned' });
    const initial = await authority.read();
    const login = await authority.login(initial.revision, pair(1));
    expect((await authority.reserveRefresh(login.revision)).status).toBe('reserved');
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('terminal-v4-standalone-auth-authority'); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    expect(await authority.read()).toEqual({ status: 'unavailable' });
    expect(await authority.login(initial.revision, pair(1))).toEqual({ status: 'unavailable' });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('aborts a late upgrade after provisioning was blocked', async () => {
    const request = { transaction: { abort: vi.fn() }, result: { createObjectStore: vi.fn(), close: vi.fn() } };
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB: { open: () => request } });
    const pending = authority.provision();
    request.onblocked();
    expect(await pending).toEqual({ status: 'unavailable' });
    request.onupgradeneeded({ oldVersion: 0 });
    expect(request.transaction.abort).toHaveBeenCalledTimes(1);
    expect(request.result.createObjectStore).not.toHaveBeenCalled();
    request.onsuccess();
    expect(request.result.close).toHaveBeenCalledTimes(1);
  });

  it('fences an old refresh after logout and a new login', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    const logout = await completeSyntheticLogout(b, login.incarnation);
    const next = await b.login(logout.revision, pair(2));
    expect((await a.completeRefresh(reserved.revision, reserved.reservation, pair(3))).status).toBe('conflict');
    const read = await a.read();
    expect(read.status === 'active' && read.incarnation === next.incarnation && JSON.stringify(read.pair) === JSON.stringify(pair(2))).toBe(true);
    expect(login.incarnation === next.incarnation).toBe(false);
  });

  it('reads a complete pair from the committed record despite delayed observers', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    // Simulate another browser storage channel lagging behind the committed authority.
    localStorage.setItem('lagging-observer', 'old');
    const update = b.compareAndSet(login.revision, pair(2));
    const reads = await Promise.all([update, ...Array.from({ length: 20 }, () => a.read())]);
    expect(reads.slice(1).every(r => r.status === 'active' && [pair(1), pair(2)].some(p => JSON.stringify(r.pair) === JSON.stringify(p)))).toBe(true);
    expect(localStorage.getItem('lagging-observer')).toBe('old');
    expect(JSON.stringify((await a.read()).pair) === JSON.stringify(pair(2))).toBe(true);
    localStorage.removeItem('lagging-observer');
  });

  it('allows only one refresh reservation and never replays an uncertain outcome', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const results = await Promise.all([a.reserveRefresh(login.revision), b.reserveRefresh(login.revision)]);
    expect(results.map(r => r.status).sort()).toEqual(['conflict', 'reserved']);
    const reserved = results.find(r => r.status === 'reserved');
    expect((await b.reserveRefresh(reserved.revision)).status).toBe('conflict');
    expect((await b.compareAndSet(reserved.revision, pair(2))).status).toBe('conflict');
    const completed = await a.completeRefresh(reserved.revision, reserved.reservation, pair(2));
    expect(completed.status).toBe('active');
    expect((await a.completeRefresh(reserved.revision, reserved.reservation, pair(2))).status).toBe('conflict');
  });

  it('rejects changing the session through a pair update', async () => {
    const { a } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    expect(await a.compareAndSet(login.revision, pair(2, 'session-other'))).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(login);
    expect((await a.compareAndSet(login.revision, pair(2))).pair).toEqual(pair(2));
  });

  it('retains a reservation when a refresh attempts to replace its session', async () => {
    const { a } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, pair(2, 'session-other'))).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual({ status: 'active', revision: reserved.revision, incarnation: reserved.incarnation, pair: pair(1), refreshReserved: true });
    expect((await a.completeRefresh(reserved.revision, reserved.reservation, pair(2))).pair).toEqual(pair(2));
  });

  it('snapshots inputs before asynchronous storage and never imports legacy state', async () => {
    const { a } = await setup();
    localStorage.setItem('legacy-auth', 'legacy value');
    const initial = await a.read();
    expect(initial.status).toBe('tombstone');
    const input = pair(1);
    const pending = a.login(initial.revision, input);
    input.accessToken = '';
    const result = await pending;
    expect(result.status === 'active' && JSON.stringify(result.pair) === JSON.stringify(pair(1))).toBe(true);
    localStorage.removeItem('legacy-auth');
  });

  it.each(['login', 'compareAndSet', 'completeRefresh'])('validates the same credential snapshot it stores for %s', async operation => {
    const { a } = await setup();
    const initial = await a.read();
    const current = operation === 'login' ? initial : await a.login(initial.revision, pair(1));
    const reserved = operation === 'completeRefresh' ? await a.reserveRefresh(current.revision) : null;
    let reads = 0;
    const input = { ...pair(2), get accessToken() { reads += 1; return reads === 1 ? 'validated-access' : ''; } };
    const result = operation === 'login' ? await a.login(current.revision, input)
      : operation === 'compareAndSet' ? await a.compareAndSet(current.revision, input)
        : await a.completeRefresh(reserved.revision, reserved.reservation, input);
    expect(result.status).toBe('active');
    expect((await a.read()).pair).toEqual({ ...pair(2), accessToken: 'validated-access' });
    expect(reads).toBe(1);
  });

  it('rejects credential objects with throwing getters', async () => {
    const { a } = await setup();
    const initial = await a.read();
    const input = { ...pair(1), get accessToken() { throw new Error('bad input'); } };
    expect(await a.login(initial.revision, input)).toEqual({ status: 'invalid' });
    expect(await a.read()).toEqual(initial);
  });

  it('rejects stale logout and stale pair updates after a refresh commits', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reservation = await a.reserveRefresh(login.revision);
    const updated = await a.completeRefresh(reservation.revision, reservation.reservation, pair(2));
    expect((await b.logout(login.revision)).status).toBe('conflict');
    expect((await b.compareAndSet(login.revision, pair(3))).status).toBe('conflict');
    expect((await a.read()).revision === updated.revision).toBe(true);
  });

  it('logs out the same incarnation after refresh commits without clearing a later login', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reservation = await a.reserveRefresh(login.revision);
    await a.completeRefresh(reservation.revision, reservation.reservation, pair(2));
    const logout = await completeSyntheticLogout(b, login.incarnation);
    expect(logout.status).toBe('tombstone');
    const next = await b.login(logout.revision, pair(3, 'session-new'));
    expect((await a.beginLogout(login.incarnation)).status).toBe('conflict');
    expect(await a.read()).toEqual(next);
    expect(next.pair.session).toBe('session-new');
  });

  it('fences refresh completion after incarnation logout', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reservation = await a.reserveRefresh(login.revision);
    const started = await b.beginLogout(login.incarnation);
    expect((await a.completeRefresh(reservation.revision, reservation.reservation, pair(2))).status).toBe('conflict');
    expect(await a.read()).toEqual({ status: 'closing', revision: started.revision, incarnation: login.incarnation, operation: started.operation });
    const logout = await b.finishLogout(started.revision, login.incarnation, started.operation, receipt);
    expect(await a.read()).toEqual(logout);
  });

  it('keeps logout pending across reopen and blocks credential operations until confirmed', async () => {
    const { a, b, indexedDB } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    expect(await a.logout(login.revision)).toEqual({ status: 'conflict' });
    const reserved = await a.reserveRefresh(login.revision);
    const started = await b.beginLogout(login.incarnation);
    expect(started).toMatchObject({ status: 'started', incarnation: login.incarnation, accessToken: pair(1).accessToken });
    const reopened = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt });
    const pending = await reopened.read();
    expect(pending).toEqual({ status: 'closing', revision: started.revision, incarnation: login.incarnation, operation: started.operation });
    expect(JSON.stringify(pending)).not.toContain(pair(1).accessToken);
    expect(await reopened.login(pending.revision, pair(2, 'session-new'))).toEqual({ status: 'conflict' });
    expect(await reopened.reserveRefresh(pending.revision)).toEqual({ status: 'conflict' });
    expect(await reopened.completeRefresh(reserved.revision, reserved.reservation, pair(2))).toEqual({ status: 'conflict' });
    expect(await reopened.logout(pending.revision)).toEqual({ status: 'conflict' });
    expect(await reopened.beginLogout(login.incarnation)).toEqual({ status: 'conflict' });
    expect(await reopened.finishLogout(started.revision, login.incarnation, 'wrong-operation')).toEqual({ status: 'conflict' });
    expect(await reopened.finishLogout(started.revision, login.incarnation, started.operation, 'pending')).toEqual({ status: 'unconfirmed' });
    expect(await reopened.read()).toEqual(pending);
    const done = await reopened.finishLogout(started.revision, login.incarnation, started.operation, receipt);
    expect(done.status).toBe('tombstone');
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const stored = await new Promise((resolve, reject) => { const tx = db.transaction('authority'); const request = tx.objectStore('authority').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    expect(stored).toEqual({ version: 1, state: 'tombstone', revision: done.revision });
    expect((await reopened.login(done.revision, pair(2, 'session-new'))).status).toBe('active');
  });

  it('does not release a pending logout without independent terminal confirmation', async () => {
    const indexedDB = new IDBFactory();
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    expect(await authority.provision()).toEqual({ status: 'provisioned' });
    const initial = await authority.read();
    const login = await authority.login(initial.revision, pair(1));
    const started = await authority.beginLogout(login.incarnation);
    expect(await authority.finishLogout(started.revision, login.incarnation, started.operation)).toEqual({ status: 'unavailable' });
    expect(await authority.read()).toEqual({ status: 'closing', revision: started.revision, incarnation: login.incarnation, operation: started.operation });
  });

  it('retains the pending logout if receipt verification fails', async () => {
    const indexedDB = new IDBFactory();
    const authority = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt: async () => { throw new Error('verification unavailable'); } });
    expect(await authority.provision()).toEqual({ status: 'provisioned' });
    const initial = await authority.read();
    const login = await authority.login(initial.revision, pair(1));
    const started = await authority.beginLogout(login.incarnation);
    expect(await authority.finishLogout(started.revision, login.incarnation, started.operation, receipt)).toEqual({ status: 'unavailable' });
    expect(await authority.read()).toEqual({ status: 'closing', revision: started.revision, incarnation: login.incarnation, operation: started.operation });
  });

  it('does not apply a delayed logout verification to a later login', async () => {
    const indexedDB = new IDBFactory();
    let release;
    let entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { entered = resolve; });
    const delayedVerifier = vi.fn(async () => { entered(); await waiting; return true; });
    const a = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt: delayedVerifier });
    const b = createStandaloneIndexedDbAuthAuthority({ indexedDB, verifyLogoutReceipt });
    expect(await a.provision()).toEqual({ status: 'provisioned' });
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const started = await a.beginLogout(login.incarnation);
    const delayed = a.finishLogout(started.revision, login.incarnation, started.operation, 'later-proof');
    await begun;
    const done = await b.finishLogout(started.revision, login.incarnation, started.operation, receipt);
    const next = await b.login(done.revision, pair(2, 'session-new'));
    release();
    expect(await delayed).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(next);
    expect(delayedVerifier).toHaveBeenCalledWith({ incarnation: login.incarnation, operation: started.operation, session: pair(1).session, owner: pair(1).owner, home: pair(1).home, receipt: 'later-proof' });
  });

  it('permits only one concurrent logout dispatch and rejects a stale incarnation', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const started = await Promise.all([a.beginLogout(login.incarnation), b.beginLogout(login.incarnation)]);
    expect(started.map(value => value.status).sort()).toEqual(['conflict', 'started']);
    const winner = started.find(value => value.status === 'started');
    const done = await a.finishLogout(winner.revision, login.incarnation, winner.operation, receipt);
    const next = await b.login(done.revision, pair(2, 'session-new'));
    expect(await a.beginLogout(login.incarnation)).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(next);
  });

  it('advances a signed-out epoch to fence a previously started login', async () => {
    const { a, b } = await setup();
    const loginIntent = await a.read();
    const logout = await b.logout(loginIntent.revision);
    expect(logout.status).toBe('tombstone');
    expect(logout.revision).not.toBe(loginIntent.revision);
    expect(await a.login(loginIntent.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(logout);
  });

  it('keeps uncertain reservations but permits a confirmed nonrotating refresh to be reused', async () => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reservation = await a.reserveRefresh(login.revision);
    const reopened = createStandaloneIndexedDbAuthAuthority({ indexedDB });
    expect((await reopened.reserveRefresh(reservation.revision)).status).toBe('conflict');
    const sameRefresh = { ...pair(2), refreshToken: pair(1).refreshToken };
    const completed = await a.completeRefresh(reservation.revision, reservation.reservation, sameRefresh);
    expect((await reopened.reserveRefresh(completed.revision)).status).toBe('reserved');
  });

  it.each(['uncertain', 'finished'])('blocks a %s refresh token after logout and login', async outcome => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    if (outcome === 'finished') await a.completeRefresh(reserved.revision, reserved.reservation, pair(2));
    const logout = await completeSyntheticLogout(b, login.incarnation);
    expect(await b.login(logout.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.read()).toEqual(logout);
  });

  it('does not release an uncertain token on stale nonrotating completion', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    const logout = await completeSyntheticLogout(b, login.incarnation);
    expect(await b.login(logout.revision, pair(1))).toEqual({ status: 'conflict' });
    expect(await a.completeRefresh(reserved.revision, reserved.reservation, pair(1))).toEqual({ status: 'conflict' });
    expect(await b.read()).toEqual(logout);
  });

  it('serializes reservation against a concurrent logout and login', async () => {
    const { a, b } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const [reserved, started] = await Promise.all([a.reserveRefresh(login.revision), b.beginLogout(login.incarnation)]);
    expect(started.status).toBe('started');
    const tombstone = await b.finishLogout(started.revision, login.incarnation, started.operation, receipt);
    const next = await b.login(tombstone.revision, pair(1));
    if (reserved.status === 'reserved') expect(next.status).toBe('conflict');
    else expect((await b.reserveRefresh(next.revision)).status).toBe('reserved');
  });

  it('permits a confirmed nonrotating token after a new login', async () => {
    const { a } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    const completed = await a.completeRefresh(reserved.revision, reserved.reservation, { ...pair(2), refreshToken: pair(1).refreshToken });
    expect(completed.status).toBe('active');
    const logout = await completeSyntheticLogout(a, login.incarnation);
    const next = await a.login(logout.revision, pair(1));
    expect((await a.reserveRefresh(next.revision)).status).toBe('reserved');
  });

  it.each([undefined, { version: 1, entries: ['bad'] }, { version: 1, entries: [], extra: true }])('fails closed on missing or malformed history', async history => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('terminal-v4-standalone-auth-authority', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); const store = tx.objectStore('authority'); if (history === undefined) store.delete('history'); else store.put(history, 'history'); tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
    expect(await a.provision()).toEqual({ status: 'existing' });
    expect(await a.read()).toEqual({ status: 'unavailable' });
    expect(await a.login(initial.revision, pair(1))).toEqual({ status: 'unavailable' });
  });

  it.each([
    ['all holes', new Array(1)],
    ['leading hole', [, { fingerprint: 'a'.repeat(64), reservation: 'previous' }]],
    ['trailing hole', [{ fingerprint: 'a'.repeat(64), reservation: 'previous' }, ,]],
    ['undefined entry', [undefined]],
  ])('rejects %s in stored history without reserving a refresh', async (_label, entries) => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    const active = await a.login(initial.revision, pair(1));
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('terminal-v4-standalone-auth-authority', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); tx.objectStore('authority').put({ version: 1, entries }, 'history'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    expect(await a.read()).toEqual({ status: 'unavailable' });
    expect(await a.reserveRefresh(active.revision)).toEqual({ status: 'unavailable' });
    const stored = await new Promise((resolve, reject) => { const tx = db.transaction('authority'); const request = tx.objectStore('authority').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    expect(stored.reservation).toBeNull();
    db.close();
  });

  it('rejects a reservation whose history fingerprint no longer matches its refresh token', async () => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    const login = await a.login(initial.revision, pair(1));
    const reserved = await a.reserveRefresh(login.revision);
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('terminal-v4-standalone-auth-authority', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); tx.objectStore('authority').put({ version: 1, entries: [{ fingerprint: 'a'.repeat(64), reservation: reserved.reservation }] }, 'history'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    expect(await a.read()).toEqual({ status: 'unavailable' });
    expect(await a.beginLogout(login.incarnation)).toEqual({ status: 'unavailable' });
  });

  it('fails closed for malformed records, invalid pairs, and unavailable storage', async () => {
    const { a, indexedDB } = await setup();
    const initial = await a.read();
    expect((await a.login(initial.revision, { session: 'incomplete' })).status).toBe('invalid');
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('terminal-v4-standalone-auth-authority', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); tx.objectStore('authority').put({ broken: true }, 'current'); tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
    expect((await a.read()).status).toBe('unavailable');
    expect((await a.logout(initial.revision)).status).toBe('unavailable');
    expect((await createStandaloneIndexedDbAuthAuthority({ indexedDB: null }).read()).status).toBe('unavailable');
  });
});
