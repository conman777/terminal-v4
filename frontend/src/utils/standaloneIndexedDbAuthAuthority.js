import { sha256 } from '@noble/hashes/sha256';

// Standalone groundwork: all callers must use this authority; it does not fence legacy storage.
const LEGACY_DATABASE = 'terminal-v4-standalone-auth-authority';
const BROWSER_DATABASE = 'terminal-v4-browser-auth-authority-v2';
const STORE = 'authority';
const KEY = 'current';
const HISTORY = 'history';
const unavailable = () => ({ status: 'unavailable' });
const nonempty = value => typeof value === 'string' && value.length > 0;
const fingerprint = value => Array.from(sha256(new TextEncoder().encode(value)), byte => byte.toString(16).padStart(2, '0')).join('');
const validOwner = value => nonempty(value) && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const validHome = value => {
  if (!nonempty(value) || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
};
const validPair = pair => pair && typeof pair === 'object' && !Array.isArray(pair)
  && ['accessToken,home,logoutCapability,owner,refreshToken,session', 'accessToken,home,owner,refreshToken,session'].includes(Object.keys(pair).sort().join(','))
  && validOwner(pair.session) && nonempty(pair.accessToken) && nonempty(pair.refreshToken)
  && validOwner(pair.owner) && validHome(pair.home)
  && (!Object.hasOwn(pair, 'logoutCapability') || (typeof pair.logoutCapability === 'string' && /^[0-9a-f]{64}$/.test(pair.logoutCapability)));
const snapshotUser = user => {
  try {
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    const json = JSON.stringify(user);
    if (typeof json !== 'string' || json.length > 16384) return null;
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validOwner(value.id) || typeof value.username !== 'string'
      || !value.username.trim() || value.username.length > 1024
      || /[\u0000-\u001f\u007f]/.test(value.username)) return null;
    return value;
  } catch { return null; }
};
const validRecord = record => {
  if (!record || record.version !== 1 || !nonempty(record.revision)) return false;
  const fields = Object.keys(record);
  const allowed = record.state === 'tombstone'
    ? ['revision', 'state', 'version', 'loginRecovery', 'retirementOperations', 'currentLoginClaim']
    : ['revision', 'state', 'version', 'incarnation', 'pair', 'reservation', 'operation', 'user', 'loginRecovery', 'retirementOperations', 'currentLoginClaim'];
  if (fields.some(field => !allowed.includes(field))) return false;
  const validIds = values => Array.isArray(values) && values.length > 0 && values.length <= 64
    && Array.from(values).every(validOwner) && new Set(values).size === values.length;
  if ((Object.hasOwn(record, 'loginRecovery') && !validIds(record.loginRecovery))
    || (Object.hasOwn(record, 'retirementOperations') && !validIds(record.retirementOperations))
    || (Object.hasOwn(record, 'currentLoginClaim') && !validOwner(record.currentLoginClaim))) return false;
  if (record.state === 'tombstone') return true;
  if (record.state === 'active' && Object.hasOwn(record, 'operation')) return false;
  if (record.state === 'closing' && !nonempty(record.operation)) return false;
  return ['active', 'closing'].includes(record.state)
    && nonempty(record.incarnation) && validPair(record.pair)
    && (!Object.hasOwn(record, 'user') || snapshotUser(record.user)?.id === record.pair.owner)
    && (record.reservation === null || nonempty(record.reservation));
};

const validHistory = history => {
  if (!history || Object.keys(history).some(key => !['entries', 'version', 'profileRequired', 'loginIntent', 'retirements', 'controlRevision', 'unresolvedLogins'].includes(key))
    || (Object.hasOwn(history, 'profileRequired') && history.profileRequired !== true)
    || (Object.hasOwn(history, 'controlRevision') && !validOwner(history.controlRevision))
    || history.version !== 1 || !Array.isArray(history.entries)) return false;
  const validIntent = intent => intent && validOwner(intent.id) && validHome(intent.home)
    && (Object.keys(intent).sort().join(',') === 'home,id'
      || (Object.keys(intent).sort().join(',') === 'claimed,home,id,operationKey' && intent.claimed === true && typeof intent.operationKey === 'string' && /^[0-9a-f]{64}$/.test(intent.operationKey)));
  if (Object.hasOwn(history, 'loginIntent') && (history.profileRequired !== true || !validIntent(history.loginIntent))) return false;
  if (Object.hasOwn(history, 'unresolvedLogins')) {
    if (history.profileRequired !== true || !Array.isArray(history.unresolvedLogins) || !history.unresolvedLogins.length || history.unresolvedLogins.length > 64) return false;
    const ids = new Set();
    for (const intent of history.unresolvedLogins) {
      if (!validIntent(intent) || intent.claimed !== true || ids.has(intent.id) || intent.id === history.loginIntent?.id) return false;
      ids.add(intent.id);
    }
  }
  if (Object.hasOwn(history, 'retirements')) {
    if (history.profileRequired !== true || !Array.isArray(history.retirements) || !history.retirements.length || history.retirements.length > 64) return false;
    const incarnations = new Set();
    const operations = new Set();
    const sessions = new Set();
    for (const entry of history.retirements) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'home,incarnation,logoutCapability,operation,owner,session'
        || !nonempty(entry.incarnation) || !nonempty(entry.operation) || !validOwner(entry.owner) || !validOwner(entry.session)
        || !validHome(entry.home) || typeof entry.logoutCapability !== 'string' || !/^[0-9a-f]{64}$/.test(entry.logoutCapability)
        || incarnations.has(entry.incarnation) || operations.has(entry.operation) || sessions.has(`${entry.home}\0${entry.session}`)) return false;
      incarnations.add(entry.incarnation);
      operations.add(entry.operation);
      sessions.add(`${entry.home}\0${entry.session}`);
    }
  }
  const fingerprints = new Set();
  const reservations = new Set();
  for (const entry of history.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'fingerprint,reservation'
      || typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)
      || !nonempty(entry.reservation) || fingerprints.has(entry.fingerprint) || reservations.has(entry.reservation)) return false;
    fingerprints.add(entry.fingerprint);
    reservations.add(entry.reservation);
  }
  return true;
};

// Provisioning must be authorized by an independent installation authority;
// an absent database cannot prove it is a fresh installation.
// Existing databases without history cannot be safely migrated and fail closed.
// Revisions and reservations are opaque capabilities generated before the transaction commits.
function createAuthority({ indexedDB = globalThis.indexedDB, verifyLogoutReceipt, verifyLoginFailureReceipt } = {}, database, strict) {
  const id = () => globalThis.crypto.randomUUID();
  const open = (provision = false) => new Promise((resolve, reject) => {
    if (!indexedDB) { reject(); return; }
    let settled = false;
    let created = false;
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = event => {
      if (settled || !provision || event.oldVersion !== 0) { request.transaction.abort(); return; }
      const store = request.result.createObjectStore(STORE);
      store.put({ version: 1, state: 'tombstone', revision: id() }, KEY);
      store.put({ version: 1, entries: [], ...(strict ? { profileRequired: true, controlRevision: id() } : {}) }, HISTORY);
      created = true;
    };
    request.onerror = () => { settled = true; reject(); };
    request.onblocked = () => { settled = true; reject(); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve({ db: request.result, created });
    };
  });

  async function transact(mode, action) {
    let db;
    try {
      ({ db } = await open());
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        const request = store.get(KEY);
        const historyRequest = store.get(HISTORY);
        historyRequest.onsuccess = () => {
          try {
            const record = request.result;
            const history = historyRequest.result;
            const sameIds = (left, right) => left.length === right.length && left.every(value => right.includes(value));
            if (!validRecord(record) || !validHistory(history)
              || (strict && !validOwner(history.controlRevision))
              || (strict && ['active', 'closing'].includes(record.state) && !Object.hasOwn(record.pair, 'logoutCapability'))
              || (strict && ['active', 'closing'].includes(record.state) && history.retirements?.some(entry => entry.incarnation === record.incarnation || (entry.home === record.pair.home && entry.session === record.pair.session)))
              || (strict && !sameIds(record.retirementOperations || [], (history.retirements || []).map(entry => entry.operation)))
              || (strict && !sameIds(record.loginRecovery || [], (history.unresolvedLogins || []).map(entry => entry.id)))
              || (strict && (record.currentLoginClaim || null) !== (history.loginIntent?.claimed ? history.loginIntent.id : null))
              || (Object.hasOwn(record, 'user') && history.profileRequired !== true)
              || (history.profileRequired === true && ['active', 'closing'].includes(record.state) && !Object.hasOwn(record, 'user'))
              || (['active', 'closing'].includes(record.state) && record.reservation === null
                && history.entries.some(entry => entry.fingerprint === fingerprint(record.pair.refreshToken)
                  && !(strict && record.state === 'closing' && entry.reservation === record.operation)))
              || (['active', 'closing'].includes(record.state) && record.reservation !== null
                && !history.entries.some(entry => entry.reservation === record.reservation
                  && entry.fingerprint === fingerprint(record.pair.refreshToken)))) { tx.abort(); return; }
            const outcome = action(record, history);
            result = outcome.result;
            if (outcome.record) store.put(outcome.record, KEY);
            if (outcome.history) store.put(outcome.history, HISTORY);
          } catch { tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject();
        tx.onerror = () => {};
      });
    } catch { return unavailable(); }
    finally { db?.close(); }
  }

  const visiblePair = pair => {
    if (!strict) return pair;
    const { logoutCapability: _capability, ...visible } = pair;
    return visible;
  };
  const snapshot = record => record.state === 'tombstone'
    ? { status: 'tombstone', revision: record.revision }
    : record.state === 'closing'
      ? { status: 'closing', revision: record.revision, incarnation: record.incarnation, operation: record.operation }
      : { status: 'active', revision: record.revision, incarnation: record.incarnation, pair: visiblePair(record.pair), refreshReserved: record.reservation !== null, ...(Object.hasOwn(record, 'user') ? { user: record.user } : {}) };
  const publicSnapshot = (record, history) => {
    const pending = strict && record.state !== 'closing' && (history.unresolvedLogins?.length || history.loginIntent?.claimed)
      ? 'login-recovery-pending'
      : strict && record.state !== 'closing' && history.retirements?.length ? 'retirement-pending' : null;
    const result = pending
      ? { status: pending, revision: record.revision, ...(record.state === 'active' ? { incarnation: record.incarnation } : {}), pendingCount: (history.unresolvedLogins?.length || 0) + (history.retirements?.length || 0) + (history.loginIntent?.claimed ? 1 : 0) }
      : snapshot(record);
    return strict ? { ...result, controlRevision: history.controlRevision } : result;
  };
  const conflict = () => ({ result: { status: 'conflict' } });
  const invalid = () => Promise.resolve({ status: 'invalid' });
  const write = (record, result = snapshot(record)) => ({ record, result });
  const clearLoginIntent = history => {
    const { loginIntent: _ignored, ...remaining } = history;
    return remaining;
  };
  const withIds = (record, key, values) => {
    const result = { ...record };
    if (values.length) result[key] = values;
    else delete result[key];
    return result;
  };
  const archiveLogin = (record, history) => {
    const intent = history.loginIntent;
    const clean = clearLoginIntent(history);
    if (!strict || !intent?.claimed) return { record, history: clean };
    const unresolved = [...(history.unresolvedLogins || []), intent];
    if (unresolved.length > 64) return null;
    const updated = withIds(record, 'loginRecovery', unresolved.map(value => value.id));
    delete updated.currentLoginClaim;
    return { record: updated, history: { ...clean, unresolvedLogins: unresolved } };
  };
  const addRetirement = (record, history, retirement) => {
    if (history.retirements?.some(value => value.home === retirement.home && value.session === retirement.session)) return null;
    const retirements = [...(history.retirements || []), retirement];
    if (retirements.length > 64) return null;
    return { record: withIds(record, 'retirementOperations', retirements.map(value => value.operation)), history: { ...history, retirements } };
  };
  const markRefreshSpent = (history, token, reservation) => {
    const tokenFingerprint = fingerprint(token);
    if (history.entries.some(entry => entry.fingerprint === tokenFingerprint)) return history;
    if (history.entries.some(entry => entry.reservation === reservation)) return null;
    return { ...history, entries: [...history.entries, { fingerprint: tokenFingerprint, reservation }] };
  };
  const snapshotPair = pair => {
    try {
      if (!pair || typeof pair !== 'object' || Array.isArray(pair)
        || !['accessToken,home,logoutCapability,owner,refreshToken,session', 'accessToken,home,owner,refreshToken,session'].includes(Object.keys(pair).sort().join(','))) return null;
      const value = { session: pair.session, accessToken: pair.accessToken, refreshToken: pair.refreshToken, owner: pair.owner, home: pair.home, ...(Object.hasOwn(pair, 'logoutCapability') ? { logoutCapability: pair.logoutCapability } : {}) };
      return validPair(value) ? value : null;
    } catch { return null; }
  };

  return {
    provision: async () => {
      try {
        const { db, created } = await open(true);
        db.close();
        return { status: created ? 'provisioned' : 'existing' };
      } catch { return unavailable(); }
    },
    read: () => transact('readonly', (record, history) => ({ result: publicSnapshot(record, history) })),
    readWithUser: () => transact('readonly', (record, history) => ({ result: record.state === 'active' && !Object.hasOwn(record, 'user') ? unavailable() : publicSnapshot(record, history) })),
    beginLogin: home => {
      if (!validHome(home)) return invalid();
      return transact('readwrite', (record, history) => {
        if (record.state === 'closing' || (record.state === 'active' && !Object.hasOwn(record, 'user')) || (strict && history.retirements?.length)) return conflict();
        const archived = archiveLogin(record, history);
        if (!archived) return conflict();
        const intent = id();
        const updated = record.state === 'tombstone' ? { ...archived.record, revision: id() } : archived.record;
        return { record: updated, history: { ...archived.history, profileRequired: true, loginIntent: { id: intent, home }, ...(strict ? { controlRevision: id() } : {}) }, result: { status: 'login-pending', intent } };
      });
    },
    claimLogin: intent => {
      if (!validOwner(intent)) return invalid();
      let operationKey;
      try { operationKey = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
      catch { return Promise.resolve(unavailable()); }
      return transact('readwrite', (record, history) => {
        if (history.loginIntent?.id !== intent || (strict && history.retirements?.length)) return conflict();
        if (history.loginIntent.claimed) return { result: { status: 'already-claimed' } };
        if (strict && (history.unresolvedLogins?.length || 0) >= 64) return conflict();
        const claimed = { ...history.loginIntent, claimed: true, operationKey };
        const updated = strict ? { ...record, currentLoginClaim: intent } : record;
        return { record: updated, history: { ...history, loginIntent: claimed }, result: { status: 'claimed', intent, home: claimed.home, operationKey } };
      });
    },
    pendingLogins: () => !strict ? invalid() : transact('readonly', (_record, history) => ({ result: { status: 'pending', logins: [...(history.unresolvedLogins || []).map(value => ({ intent: value.id, home: value.home, state: 'unresolved' })), ...(history.loginIntent?.claimed ? [{ intent: history.loginIntent.id, home: history.loginIntent.home, state: 'claimed' }] : [])] } })),
    resumeLogin: intent => !validOwner(intent) ? invalid() : transact('readonly', (_record, history) => {
      const current = history.loginIntent?.id === intent ? history.loginIntent : null;
      const saved = current || history.unresolvedLogins?.find(value => value.id === intent);
      if (!saved?.claimed) return conflict();
      return { result: { status: current ? 'claimed' : 'unresolved', intent, home: saved.home, operationKey: saved.operationKey } };
    }),
    cancelUnclaimedLogin: intent => !strict || !validOwner(intent) ? invalid() : transact('readwrite', (record, history) => {
      if (history.loginIntent?.id !== intent || history.loginIntent.claimed) return conflict();
      const updated = { ...record };
      if (updated.state !== 'closing' && !(updated.state === 'active' && updated.reservation !== null)) updated.revision = id();
      return { record: updated, history: { ...clearLoginIntent(history), controlRevision: id() }, result: { status: 'cancelled' } };
    }),
    completeLoginFailure: async (intent, receipt) => {
      if (!strict || !validOwner(intent)) return invalid();
      const pending = await transact('readonly', (_record, history) => {
        const current = history.loginIntent?.id === intent ? history.loginIntent : null;
        const saved = current || history.unresolvedLogins?.find(value => value.id === intent);
        return { result: saved?.claimed ? { intent, home: saved.home, operationKey: saved.operationKey } : null };
      });
      if (pending?.status === 'unavailable') return pending;
      if (!pending) return { status: 'conflict' };
      if (typeof verifyLoginFailureReceipt !== 'function') return unavailable();
      try {
        if (await verifyLoginFailureReceipt({ ...pending, receipt }) !== true) return { status: 'unconfirmed' };
      } catch { return unavailable(); }
      return transact('readwrite', (record, history) => {
        const current = history.loginIntent?.id === intent ? history.loginIntent : null;
        const saved = current || history.unresolvedLogins?.find(value => value.id === intent);
        if (!saved?.claimed || saved.home !== pending.home || saved.operationKey !== pending.operationKey) return conflict();
        let updated = { ...record };
        let nextHistory;
        if (current) {
          delete updated.currentLoginClaim;
          nextHistory = clearLoginIntent(history);
        } else {
          const remaining = history.unresolvedLogins.filter(value => value.id !== intent);
          const { unresolvedLogins: _unresolved, ...rest } = history;
          nextHistory = remaining.length ? { ...rest, unresolvedLogins: remaining } : rest;
          updated = withIds(updated, 'loginRecovery', remaining.map(value => value.id));
        }
        if (updated.state !== 'closing' && !(updated.state === 'active' && updated.reservation !== null)) updated.revision = id();
        nextHistory.controlRevision = id();
        return { record: updated, history: nextHistory, result: { status: 'no-session' } };
      });
    },
    login: (expected, pair) => {
      const value = nonempty(expected) ? snapshotPair(pair) : null;
      if (!value) return invalid();
      const tokenFingerprint = fingerprint(value.refreshToken);
      return transact('readwrite', (record, history) => {
        if (record.revision !== expected || record.state === 'closing' || history.profileRequired === true
          || history.entries.some(entry => entry.fingerprint === tokenFingerprint)) return conflict();
        return write({ version: 1, state: 'active', revision: id(), incarnation: id(), pair: value, reservation: null });
      });
    },
    loginWithUser: (intent, pair, user) => {
      const value = nonempty(intent) ? snapshotPair(pair) : null;
      const profile = snapshotUser(user);
      if (!value || (strict && !Object.hasOwn(value, 'logoutCapability'))) return invalid();
      const tokenFingerprint = fingerprint(value.refreshToken);
      return transact('readwrite', (record, history) => {
        const unresolved = strict && history.unresolvedLogins?.find(entry => entry.id === intent);
        if (unresolved) {
          if (unresolved.home !== value.home || (['active', 'closing'].includes(record.state)
            && ((record.pair.home === value.home && record.pair.session === value.session) || record.pair.refreshToken === value.refreshToken))) return conflict();
          const remaining = history.unresolvedLogins.filter(entry => entry.id !== intent);
          const { unresolvedLogins: _unresolved, ...rest } = history;
          const nextHistory = markRefreshSpent(remaining.length ? { ...rest, unresolvedLogins: remaining } : rest, value.refreshToken, id());
          if (!nextHistory) return conflict();
          const current = withIds(record, 'loginRecovery', remaining.map(entry => entry.id));
          const archived = addRetirement(current, nextHistory, { incarnation: id(), operation: id(), session: value.session, owner: value.owner, home: value.home, logoutCapability: value.logoutCapability });
          if (!archived) return conflict();
          if (archived.record.state !== 'closing') archived.record.revision = id();
          archived.history.controlRevision = id();
          return { ...write(archived.record, publicSnapshot(archived.record, archived.history)), history: archived.history };
        }
        if (!profile || profile.id !== value.owner) return { result: { status: 'invalid' } };
        if (history.loginIntent?.id !== intent || history.loginIntent.home !== value.home || record.state === 'closing'
          || (strict && !history.loginIntent.claimed)
          || history.entries.some(entry => entry.fingerprint === tokenFingerprint)) return conflict();
        if (strict && record.state === 'active' && ((record.pair.home === value.home && record.pair.session === value.session) || record.pair.refreshToken === value.refreshToken)) return conflict();
        let updated = { version: 1, state: 'active', revision: id(), incarnation: id(), pair: value, user: profile, reservation: null };
        if (strict) {
          updated = withIds(updated, 'loginRecovery', (history.unresolvedLogins || []).map(entry => entry.id));
          updated = withIds(updated, 'retirementOperations', (history.retirements || []).map(entry => entry.operation));
        }
        let nextHistory = clearLoginIntent(history);
        if (strict) nextHistory.controlRevision = id();
        if (strict && record.state === 'active') {
          const operation = id();
          nextHistory = markRefreshSpent(nextHistory, record.pair.refreshToken, operation);
          if (!nextHistory) return conflict();
          const archived = addRetirement(updated, nextHistory, { incarnation: record.incarnation, operation, session: record.pair.session, owner: record.pair.owner, home: record.pair.home, logoutCapability: record.pair.logoutCapability });
          if (!archived) return conflict();
          updated = archived.record;
          nextHistory = archived.history;
        }
        return { ...write(updated, publicSnapshot(updated, nextHistory)), history: nextHistory };
      });
    },
    updateUser: (expected, user) => {
      const profile = nonempty(expected) ? snapshotUser(user) : null;
      if (!profile) return invalid();
      return transact('readwrite', (record, history) => {
        if (record.revision !== expected || record.state !== 'active' || record.reservation !== null || !Object.hasOwn(record, 'user') || (strict && history.retirements?.length)) return conflict();
        if (profile.id !== record.pair.owner) return { result: { status: 'invalid' } };
        const merged = snapshotUser({ ...record.user, ...profile });
        if (!merged) return { result: { status: 'invalid' } };
        const updated = { ...record, revision: id(), user: merged };
        return write(updated, publicSnapshot(updated, history));
      });
    },
    logout: expected => !nonempty(expected) ? invalid() : transact('readwrite', (record, history) => {
      if (record.revision !== expected || record.state !== 'tombstone') return conflict();
      const archived = archiveLogin(record, history);
      if (!archived) return conflict();
      const updated = { ...archived.record, revision: id() };
      if (strict) archived.history.controlRevision = id();
      return { ...write(updated, publicSnapshot(updated, archived.history)), history: archived.history };
    }),
    beginLogout: (incarnation, controlRevision) => !nonempty(incarnation) ? invalid() : transact('readwrite', (record, history) => {
      if (record.state !== 'active' || record.incarnation !== incarnation
        || (strict && (history.retirements?.length || controlRevision !== history.controlRevision))) return conflict();
      const archived = archiveLogin(record, history);
      if (!archived) return conflict();
      const closing = { ...archived.record, state: 'closing', revision: id(), operation: id() };
      if (strict) archived.history = markRefreshSpent(archived.history, record.pair.refreshToken, closing.operation);
      if (!archived.history) return conflict();
      const request = strict
        ? { session: record.pair.session, owner: record.pair.owner, home: record.pair.home, logoutCapability: record.pair.logoutCapability }
        : { accessToken: record.pair.accessToken };
      if (strict) archived.history.controlRevision = id();
      return { ...write(closing, { status: 'started', revision: closing.revision, incarnation, operation: closing.operation, ...request }), history: archived.history };
    }),
    resumeLogout: incarnation => !strict || !nonempty(incarnation) ? invalid() : transact('readonly', (record, history) => {
      if (record.state !== 'closing' || record.incarnation !== incarnation) return conflict();
      return { result: { status: 'started', revision: record.revision, incarnation, operation: record.operation, session: record.pair.session, owner: record.pair.owner, home: record.pair.home, logoutCapability: record.pair.logoutCapability } };
    }),
    pendingRetirements: () => !strict ? invalid() : transact('readonly', (_record, history) => ({ result: { status: 'pending', retirements: history.retirements || [] } })),
    completeRetirement: async (incarnation, operation, receipt) => {
      if (!strict || !nonempty(incarnation) || !nonempty(operation)) return invalid();
      const pending = await transact('readonly', (_record, history) => ({ result: history.retirements?.find(entry => entry.incarnation === incarnation && entry.operation === operation) || null }));
      if (pending?.status === 'unavailable') return pending;
      if (!pending) return { status: 'conflict' };
      if (typeof verifyLogoutReceipt !== 'function') return unavailable();
      try {
        if (await verifyLogoutReceipt({ ...pending, receipt }) !== true) return { status: 'unconfirmed' };
      } catch { return unavailable(); }
      return transact('readwrite', (record, history) => {
        const current = history.retirements?.find(entry => entry.incarnation === incarnation && entry.operation === operation);
        if (!current || !record.retirementOperations?.includes(operation) || JSON.stringify(current) !== JSON.stringify(pending)) return conflict();
        const remaining = history.retirements.filter(entry => entry !== current);
        const { retirements: _retirements, ...rest } = history;
        const updated = withIds(record, 'retirementOperations', remaining.map(entry => entry.operation));
        if (updated.state !== 'closing') updated.revision = id();
        return { record: updated, history: remaining.length ? { ...rest, controlRevision: id(), retirements: remaining } : { ...rest, controlRevision: id() }, result: { status: 'retired' } };
      });
    },
    finishLogout: async (expected, incarnation, operation, receipt) => {
      if (!nonempty(expected) || !nonempty(incarnation) || !nonempty(operation)) return invalid();
      const pending = await transact('readonly', record => {
        if (record.state !== 'closing' || record.revision !== expected || record.incarnation !== incarnation || record.operation !== operation) return conflict();
        return { result: { status: 'closing', session: record.pair.session, owner: record.pair.owner, home: record.pair.home, ...(strict ? { logoutCapability: record.pair.logoutCapability } : {}) } };
      });
      if (pending.status !== 'closing') return pending;
      if (typeof verifyLogoutReceipt !== 'function') return unavailable();
      try {
        if (await verifyLogoutReceipt({ incarnation, operation, session: pending.session, owner: pending.owner, home: pending.home, ...(strict ? { logoutCapability: pending.logoutCapability } : {}), receipt }) !== true) return { status: 'unconfirmed' };
      } catch { return unavailable(); }
      return transact('readwrite', (record, history) => {
        if (record.state !== 'closing' || record.revision !== expected || record.incarnation !== incarnation || record.operation !== operation
          || record.pair.session !== pending.session || record.pair.owner !== pending.owner || record.pair.home !== pending.home
          || (strict && record.pair.logoutCapability !== pending.logoutCapability)) return conflict();
        let updated = { version: 1, state: 'tombstone', revision: id() };
        if (strict) {
          updated = withIds(updated, 'loginRecovery', record.loginRecovery || []);
          updated = withIds(updated, 'retirementOperations', record.retirementOperations || []);
        }
        return write(updated, publicSnapshot(updated, history));
      });
    },
    compareAndSet: (expected, pair) => {
      const value = nonempty(expected) ? snapshotPair(pair) : null;
      if (!value) return invalid();
      const tokenFingerprint = fingerprint(value.refreshToken);
      return transact('readwrite', (record, history) => {
        if (record.revision !== expected || record.state !== 'active' || record.reservation !== null || Object.hasOwn(record, 'user')
          || record.pair.session !== value.session || record.pair.owner !== value.owner || record.pair.home !== value.home
          || history.entries.some(entry => entry.fingerprint === tokenFingerprint)) return conflict();
        return write({ ...record, revision: id(), pair: value });
      });
    },
    reserveRefresh: async expected => {
      if (!nonempty(expected)) return invalid();
      const current = await transact('readonly', (record, history) => ({ result: publicSnapshot(record, history) }));
      if (current.status === 'unavailable') return current;
      if (current.status !== 'active' || current.revision !== expected || current.refreshReserved) return { status: 'conflict' };
      let fingerprint;
      try {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.pair.refreshToken));
        fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      } catch { return unavailable(); }
      return transact('readwrite', (record, history) => {
        if (record.revision !== expected || record.state !== 'active' || record.reservation !== null
          || (strict && (publicSnapshot(record, history).status !== 'active' || current.controlRevision !== history.controlRevision))
          || record.pair.refreshToken !== current.pair.refreshToken || history.entries.some(entry => entry.fingerprint === fingerprint)) return conflict();
        const next = { ...record, revision: id(), reservation: id() };
        return { ...write(next, { status: 'reserved', revision: next.revision, incarnation: next.incarnation, reservation: next.reservation, pair: visiblePair(next.pair), ...(Object.hasOwn(next, 'user') ? { user: next.user } : {}), ...(strict ? { controlRevision: history.controlRevision } : {}) }),
          history: { ...history, entries: [...history.entries, { fingerprint, reservation: next.reservation }] } };
      });
    },
    // Only the trusted caller holding this exact reservation may invoke this
    // before it has called the refresh transport. The store cannot prove that
    // an external request was never sent.
    releaseUndispatchedRefresh: (expected, incarnation, reservation) => {
      if (!strict || !nonempty(expected) || !nonempty(incarnation) || !nonempty(reservation)) return invalid();
      return transact('readwrite', (record, history) => {
        if (record.state !== 'active' || record.revision !== expected || record.incarnation !== incarnation
          || record.reservation !== reservation) return conflict();
        const next = { ...record, revision: id(), reservation: null };
        const nextHistory = { ...history, entries: history.entries.filter(entry => entry.reservation !== reservation) };
        return { record: next, history: nextHistory, result: { status: 'released' } };
      });
    },
    completeRefresh: (expected, reservation, pair) => {
      const value = nonempty(expected) && nonempty(reservation) ? snapshotPair(pair) : null;
      if (!value) return invalid();
      const tokenFingerprint = fingerprint(value.refreshToken);
      return transact('readwrite', (record, history) => {
        if (record.revision !== expected || record.state !== 'active' || record.reservation !== reservation || (strict && history.retirements?.length)
          || record.pair.session !== value.session || record.pair.owner !== value.owner || record.pair.home !== value.home
          || (strict && Object.hasOwn(value, 'logoutCapability') && value.logoutCapability !== record.pair.logoutCapability)
          || history.entries.some(entry => entry.fingerprint === tokenFingerprint && entry.reservation !== reservation)) return conflict();
        const next = { ...record, revision: id(), pair: strict ? { ...value, logoutCapability: record.pair.logoutCapability } : value, reservation: null };
        const updated = write(next, publicSnapshot(next, history));
        return value.refreshToken === record.pair.refreshToken
          ? { ...updated, history: { ...history, entries: history.entries.filter(entry => entry.reservation !== reservation) } }
          : updated;
      });
    },
  };
}

export function createStandaloneIndexedDbAuthAuthority(options) {
  return createAuthority(options, LEGACY_DATABASE, false);
}

export function createBrowserAuthAuthority(options) {
  const { login: _legacyLogin, compareAndSet: _legacyReplace, read: _legacyRead, ...authority } = createAuthority(options, BROWSER_DATABASE, true);
  return { ...authority, read: authority.readWithUser };
}
