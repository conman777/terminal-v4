export function createApprovalIntentStore(storage, transaction, isCurrent, sessionId) {
  const key = `approvalDecision:v1:${encodeURIComponent(sessionId)}`;
  function read() {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (value?.version === 1 && value.sessionId === sessionId && typeof value.approvalId === 'string' && value.approvalId && value.approvalId.length <= 256 && (value.intentId === undefined || (typeof value.intentId === 'string' && value.intentId && value.intentId.length <= 256)) && (value.mode === undefined || value.mode === 'legacy')) return value;
    } catch { /* Invalid recovery data must remain held. */ }
    throw new Error('Saved approval recovery could not be inspected.');
  }
  return {
    read,
    reserve: (approvalId, mode = 'reservation') => transaction(() => {
      if (!isCurrent()) throw new Error('The account or environment changed.');
      if (read()) throw new Error('A previous approval needs review.');
      if (typeof approvalId !== 'string' || !approvalId || approvalId.length > 256 || !['reservation', 'legacy'].includes(mode)) throw new Error('Approval identity is invalid.');
      const intentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
      const value = JSON.stringify({ version: 1, sessionId, approvalId, intentId, ...(mode === 'legacy' ? { mode } : {}) });
      storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error('Approval recovery could not be saved.');
      return { intentId };
    }),
    clear: approvalId => transaction(() => {
      if (!isCurrent()) throw new Error('The account or environment changed.');
      if (read()?.approvalId === approvalId) storage.removeItem(key);
    }),
    clearUndispatched: (approvalId, intentId) => transaction(() => {
      const value = read();
      if (value?.approvalId === approvalId && value.intentId === intentId) storage.removeItem(key);
    }),
  };
}
