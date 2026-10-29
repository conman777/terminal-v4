export async function supervisedInputAvailability(fetch, signal) {
  const response = await fetch('/api/structured/input-capabilities', { signal, cache: 'no-store' });
  if (response.status === 404) return 'legacy';
  if (!response.ok) throw new Error('Could not verify supervised input support.');
  const value = await response.json();
  if (value?.protocol !== 1 || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw new Error('Could not verify supervised input support.');
  return value.enabled === false ? 'disabled' : 'supervised';
}

export async function supervisedRawInputCapability(fetch, signal) {
  const availability = await supervisedInputAvailability(fetch, signal);
  if (availability === 'disabled') throw new Error('Supervised input is disabled. Review pending input before continuing.');
  return availability === 'supervised';
}

export async function supervisedSessionInputCapability(fetch, signal, sessionId) {
  const response = await fetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/input-capabilities`, { signal, cache: 'no-store' });
  if (response.status === 404) return false;
  if (!response.ok || (await response.json())?.protocol !== 1) throw new Error('Could not verify supervised input support.');
  return true;
}

export async function supervisedInputWatermark(fetch, signal) {
  const response = await fetch('/api/structured/input-watermark', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('The server input watermark is unavailable.');
  const value = await response.json();
  if (value?.protocol !== 1 || !Number.isSafeInteger(value.rejectBefore) || value.rejectBefore < 0) throw new Error('The server input watermark is invalid.');
  return value.rejectBefore;
}

export function createSupervisedRawInputApi(fetch, sessionId, signal) {
  const session = encodeURIComponent(sessionId);
  const receiptUrl = requestId => `/api/structured/input-receipts/${session}/${encodeURIComponent(requestId)}`;
  return {
    async issue() {
      const response = await fetch(`/api/structured/sessions/${session}/input-operation`, { method: 'POST', signal });
      if (!response.ok) throw new Error('Could not reserve a supervised input operation. No input was sent.');
      const value = await response.json();
      if (value?.protocol !== 1 || typeof value.requestId !== 'string' || typeof value.deliveryToken !== 'string') throw new Error('Input reservation could not be confirmed. No input was sent.');
      return { requestId: value.requestId, deliveryToken: value.deliveryToken };
    },
    async send(body) {
      const response = await fetch(`/api/structured/sessions/${session}/supervised-input`, { method: 'POST', signal, body });
      const value = await response.json().catch(() => null);
      if (!response.ok || response.status !== 202 || value?.status !== 'accepted' || value.outcome !== 'delivered' || value.requestId !== body.requestId) throw new Error('Input delivery could not be confirmed.');
      return { requestId: value.requestId, status: 'delivered' };
    },
    async lookup(requestId) {
      const response = await fetch(receiptUrl(requestId), { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Input receipt unavailable.');
      const value = await response.json();
      if (value?.requestId !== requestId || value.sessionId !== sessionId) throw new Error('Input receipt does not match.');
      return { requestId, status: value.status };
    },
    async review(requestId) {
      const response = await fetch(`${receiptUrl(requestId)}/review`, { method: 'POST', signal });
      if (!response.ok) throw new Error('Input review could not be confirmed.');
      const value = await response.json();
      if (value?.requestId !== requestId || value.sessionId !== sessionId || !['reviewed', 'acknowledged'].includes(value.status)) throw new Error('Input review does not match.');
      return { requestId, status: value.status };
    },
  };
}
