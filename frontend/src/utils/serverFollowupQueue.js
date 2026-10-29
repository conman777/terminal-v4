import { apiFetch } from './api';
import { createUuid } from './createUuid';
import { integer, validateSnapshot } from './followupQueueSnapshot';

const endpoint = sessionId => `/api/structured/sessions/${encodeURIComponent(sessionId)}/queue`;
const UNAVAILABLE = new Set([400, 403, 404, 409, 422]);

export async function probeServerFollowupQueue(sessionId, signal) {
  try {
    const response = await apiFetch(endpoint(sessionId), { signal });
    const data = await response.json().catch(() => null);
    if (response.ok) return { status: 'available', snapshot: validateSnapshot(data) };
    if (UNAVAILABLE.has(response.status)) return { status: 'unavailable', reason: data?.error || 'This conversation has no server-owned follow-up queue.' };
  } catch { /* An unreachable host is not proof that no queue exists. */ }
  return { status: 'unknown' };
}

async function readSnapshot(sessionId) {
  const response = await apiFetch(endpoint(sessionId));
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Could not read the queue (${response.status}).`);
  return validateSnapshot(data);
}

async function lookupReceipt(sessionId, operationId) {
  const response = await apiFetch(`${endpoint(sessionId)}/operations/${operationId}`);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data?.operationId === operationId && integer(data.queueRevision) ? data : null;
}

export async function enqueueServerFollowup(sessionId, text) {
  let lastRejection = 'The queue changed on another device. Try again.';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await readSnapshot(sessionId);
    const mutation = { operationId: createUuid(), expectedQueueRevision: snapshot.revision, operation: { kind: 'enqueue', itemId: createUuid(), text, runWhenIdle: true } };
    let response;
    try { response = await apiFetch(endpoint(sessionId), { method: 'POST', body: mutation }); }
    catch {
      const found = await lookupReceipt(sessionId, mutation.operationId).catch(() => null);
      if (found) return { mode: snapshot.mode, queueRevision: found.queueRevision };
      throw Object.assign(new Error('The queue request could not be confirmed. Check the queue before sending this message again.'), { uncertain: true });
    }
    const data = await response.json().catch(() => null);
    if (response.ok) return { mode: snapshot.mode, queueRevision: data?.queueRevision };
    if (response.status !== 409) throw new Error(data?.error || `The queue rejected this message (${response.status}).`);
    lastRejection = data?.error || lastRejection;
  }
  throw new Error(lastRejection);
}
