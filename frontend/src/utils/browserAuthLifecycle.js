// Unwired adapter: transport and authority receipt verifiers must be provided by
// the caller. This module does not provision storage or activate a server protocol.
// Login transport must authenticate its response and bind it to the claimed home
// and operation key. Logout transport must retry the same scoped operation safely;
// the authority verifier, not a transport success alone, decides when it is final.
export function createBrowserAuthLifecycle({ authority, transport, notifications }) {
  const changed = () => { try { notifications?.publish(); } catch { /* Hints are not an authority. */ } };
  const matchesScope = (snapshot, scope) => Boolean(scope && snapshot?.incarnation === scope.incarnation
    && snapshot?.pair?.owner === scope.owner && snapshot.pair.session === scope.session
    && snapshot.pair.home === scope.home);
  const publicResult = value => ({
    status: value?.status || 'unavailable',
    ...(value?.incarnation ? { incarnation: value.incarnation } : {}),
    ...(value?.revision ? { revision: value.revision } : {}),
  });

  async function settleLogin(claim, response) {
    if (response?.kind === 'no-session') {
      const result = await authority.completeLoginFailure(claim.intent, response.receipt);
      changed(); return publicResult(result);
    }
    if (response?.kind !== 'issued') return { status: 'login-unconfirmed', intent: claim.intent };
    const pair = {
      home: claim.home, owner: response.user?.id, session: response.session,
      accessToken: response.accessToken, refreshToken: response.refreshToken,
      logoutCapability: response.logoutCapability,
    };
    const result = await authority.loginWithUser(claim.intent, pair, response.user);
    changed();
    if (['invalid', 'unavailable'].includes(result?.status)) return { status: 'login-unconfirmed', intent: claim.intent };
    return publicResult(result);
  }

  async function sendLogout(started) {
    const request = {
      home: started.home, owner: started.owner, session: started.session,
      incarnation: started.incarnation, operation: started.operation,
      logoutCapability: started.logoutCapability,
    };
    let receipt;
    try { receipt = await transport.logout(request); }
    catch { return { status: 'logout-unconfirmed', incarnation: started.incarnation }; }
    const result = await authority.finishLogout(started.revision, started.incarnation, started.operation, receipt);
    changed();
    return publicResult(result);
  }

  return {
    notifications,
    subscribe(listener) {
      if (typeof notifications?.subscribe !== 'function') throw new Error('Strict authentication notifications unavailable');
      return notifications.subscribe(listener);
    },
    read: () => authority.read(),
    pendingLogins: () => authority.pendingLogins(),
    async login(home, credentials) {
      const pending = await authority.beginLogin(home);
      changed();
      if (pending.status !== 'login-pending') return publicResult(pending);
      const claim = await authority.claimLogin(pending.intent);
      changed();
      if (claim.status === 'unavailable' || claim.status === 'already-claimed') return { status: 'login-unconfirmed', intent: pending.intent };
      if (claim.status !== 'claimed') return publicResult(claim);
      let response;
      try { response = await transport.login({ home: claim.home, intent: claim.intent, operationKey: claim.operationKey, credentials }); }
      catch { return { status: 'login-unconfirmed', intent: claim.intent }; }
      return settleLogin(claim, response);
    },
    async recoverLogin(intent) {
      const claim = await authority.resumeLogin(intent);
      if (!['claimed', 'unresolved'].includes(claim.status)) return publicResult(claim);
      let response;
      try { response = await transport.recoverLogin({ home: claim.home, intent: claim.intent, operationKey: claim.operationKey }); }
      catch { return { status: 'login-unconfirmed', intent }; }
      return settleLogin(claim, response);
    },
    async refresh(expectedScope, { signal } = {}) {
      if (signal?.aborted) return { status: 'cancelled' };
      const snapshot = await authority.read();
      if (snapshot.status !== 'active') return publicResult(snapshot);
      if (expectedScope !== undefined && !matchesScope(snapshot, expectedScope)) return { status: 'conflict' };
      if (snapshot.refreshReserved) return { status: 'refresh-pending' };
      if (signal?.aborted) return { status: 'cancelled' };
      const reserved = await authority.reserveRefresh(snapshot.revision);
      changed();
      if (reserved.status !== 'reserved') return publicResult(reserved);
      const beforeDispatch = await authority.read();
      const reservedScope = { incarnation: reserved.incarnation, owner: reserved.pair.owner, session: reserved.pair.session, home: reserved.pair.home };
      const cancelled = signal?.aborted === true;
      if (cancelled || beforeDispatch.status !== 'active' || !beforeDispatch.refreshReserved
        || beforeDispatch.revision !== reserved.revision || beforeDispatch.controlRevision !== reserved.controlRevision
        || !matchesScope(beforeDispatch, reservedScope)) {
        const released = await authority.releaseUndispatchedRefresh(reserved.revision, reserved.incarnation, reserved.reservation);
        changed();
        if (released.status === 'unavailable') return { status: 'refresh-unconfirmed' };
        return { status: cancelled ? 'cancelled' : 'conflict' };
      }
      let response;
      try { response = await transport.refresh({ home: reserved.pair.home, refreshToken: reserved.pair.refreshToken, ...(signal ? { signal } : {}) }); }
      catch { return { status: 'refresh-unconfirmed' }; }
      if (typeof response?.accessToken !== 'string' || !response.accessToken || typeof response?.refreshToken !== 'string' || !response.refreshToken) return { status: 'refresh-unconfirmed' };
      const result = await authority.completeRefresh(reserved.revision, reserved.reservation, {
        ...reserved.pair, accessToken: response.accessToken, refreshToken: response.refreshToken,
      });
      changed();
      return publicResult(result);
    },
    async logout() {
      const snapshot = await authority.read();
      if (snapshot.status === 'tombstone' || (snapshot.status === 'login-recovery-pending' && !snapshot.incarnation)) {
        const result = await authority.logout(snapshot.revision); changed(); return publicResult(result);
      }
      if (snapshot.status !== 'active' && snapshot.status !== 'login-recovery-pending') return publicResult(snapshot);
      const started = await authority.beginLogout(snapshot.incarnation, snapshot.controlRevision);
      changed();
      if (started.status !== 'started') return publicResult(started);
      return sendLogout(started);
    },
    async resumeLogout(incarnation) {
      const started = await authority.resumeLogout(incarnation);
      if (started.status !== 'started') return publicResult(started);
      return sendLogout(started);
    },
    async recoverRetirements() {
      const pending = await authority.pendingRetirements();
      if (pending.status !== 'pending') return publicResult(pending);
      for (const retirement of pending.retirements) {
        let receipt;
        try { receipt = await transport.logout({ ...retirement }); }
        catch { return { status: 'retirement-unconfirmed' }; }
        const result = await authority.completeRetirement(retirement.incarnation, retirement.operation, receipt);
        changed();
        if (result.status !== 'retired') return publicResult(result);
      }
      return publicResult(await authority.read());
    },
  };
}
