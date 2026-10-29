const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WATERMARK = 'supervisedRawInput:watermark:v1';
const operationTime = requestId => Number.parseInt(requestId.replaceAll('-', '').slice(0, 12), 16);

export function createSupervisedRawInputStore(storage, sessionId, isCurrent) {
  if (!sessionId) throw new Error('A session is required for supervised input.');
  const prefix = `supervisedRawInput:v2:${encodeURIComponent(sessionId)}:`;
  function parse(raw) {
    if (raw === null) return null;
    if (raw.length > 16_384) throw new Error('Saved input recovery is invalid.');
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('Saved input recovery is invalid.'); }
    if (!value || value.version !== 2 || value.sessionId !== sessionId || !UUID.test(value.requestId)
      || !['issued', 'sending', 'settled'].includes(value.stage)
      || (value.stage !== 'settled' && (typeof value.deliveryToken !== 'string' || !value.deliveryToken || value.deliveryToken.length > 8192))) throw new Error('Saved input recovery is invalid.');
    return value.stage === 'settled' ? { version: 2, sessionId, requestId: value.requestId, stage: 'settled' }
      : { version: 2, sessionId, requestId: value.requestId, deliveryToken: value.deliveryToken, stage: value.stage };
  }
  function readAll() {
    const keys = storage.listKeys(prefix);
    return keys.map(key => {
      const value = parse(storage.getItem(key));
      if (!value || key !== prefix + value.requestId) throw new Error('Saved input recovery is invalid.');
      return value;
    }).filter(value => value.stage !== 'settled');
  }
  function save(requestId, expected, value) {
    if (!isCurrent()) throw new Error('The account or environment changed. Input was not sent.');
    const key = prefix + requestId;
    if (storage.getItem(key) !== expected) throw new Error('Input recovery changed in another tab. Inspect the terminal before continuing.');
    const encoded = JSON.stringify(value);
    storage.setItem(key, encoded);
    if (storage.getItem(key) !== encoded) throw new Error('Input recovery could not be saved.');
  }
  return {
    read: () => readAll()[0] || null,
    readAll,
    count: () => storage.listKeys(prefix).length,
    reserve: operation => storage.transaction(() => {
      if (readAll().length) throw new Error('A previous input needs review before sending more.');
      const value = { version: 2, sessionId, requestId: operation?.requestId, deliveryToken: operation?.deliveryToken, stage: 'issued' };
      parse(JSON.stringify(value));
      const rawWatermark = storage.getItem(WATERMARK);
      if (rawWatermark !== null && (!/^\d+$/.test(rawWatermark) || !Number.isSafeInteger(Number(rawWatermark)) || operationTime(value.requestId) < Number(rawWatermark))) throw new Error('Input reservation is older than the verified server watermark.');
      save(value.requestId, null, value);
    }),
    markSending: requestId => storage.transaction(() => {
      const raw = storage.getItem(prefix + requestId), value = parse(raw);
      if (!value || value.requestId !== requestId || value.stage !== 'issued') throw new Error('Input operation does not match its saved identity.');
      save(requestId, raw, { ...value, stage: 'sending' });
    }),
    clear: requestId => storage.transaction(() => {
      const raw = storage.getItem(prefix + requestId), value = parse(raw);
      if (!value) return;
      if (value.requestId !== requestId) throw new Error('Input operation does not match its saved identity.');
      if (value.stage === 'settled') return;
      save(requestId, raw, { version: 2, sessionId, requestId, stage: 'settled' });
    }),
    compactBefore: rejectBefore => storage.transaction(() => {
      if (!isCurrent() || !Number.isSafeInteger(rejectBefore) || rejectBefore < 0) throw new Error('The server input watermark is invalid.');
      const previous = storage.getItem(WATERMARK);
      if (previous !== null && (!/^\d+$/.test(previous) || !Number.isSafeInteger(Number(previous)))) throw new Error('The saved input watermark is invalid.');
      const watermark = Math.max(Number(previous || 0), rejectBefore);
      storage.setItem(WATERMARK, String(watermark));
      for (const key of storage.listKeys(prefix)) {
        const value = parse(storage.getItem(key));
        if (!value || key !== prefix + value.requestId) throw new Error('Saved input recovery is invalid.');
        if (value.stage === 'settled' && operationTime(value.requestId) < watermark) storage.removeItem(key);
      }
    }),
  };
}

export function listSupervisedRawInputSessions(cacheScope, activeEnvironment) {
  if (!cacheScope?.identity) return [];
  const prefix = `${cacheScope.identity}${activeEnvironment ? `environment:${activeEnvironment.id}:` : ''}supervisedRawInput:v2:`;
  const sessions = [];
  for (const key of Object.keys(localStorage)) {
    if (!key?.startsWith(prefix)) continue;
    try {
      const suffix = key.slice(prefix.length), separator = suffix.lastIndexOf(':');
      if (separator < 0 || !UUID.test(suffix.slice(separator + 1))) throw new Error();
      const sessionId = decodeURIComponent(suffix.slice(0, separator));
      const value = JSON.parse(localStorage.getItem(key));
      if (!value || value.version !== 2 || value.sessionId !== sessionId || value.requestId !== suffix.slice(separator + 1)
        || !['issued', 'sending', 'settled'].includes(value.stage)) throw new Error();
      if (value.stage === 'settled') continue;
      if (sessionId && !sessions.includes(sessionId)) sessions.push(sessionId);
    } catch { throw new Error('Saved input recovery could not be inspected.'); }
  }
  return sessions;
}
