import { createUuid } from './createUuid';
import { apiFetch } from './api';

const root = '/api/agent/connections';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const newConnectionId = () => createUuid();
const id = value => {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid connection identifier.');
  return encodeURIComponent(value);
};

async function request(path, options) {
  const response = await apiFetch(path, { ...options, home: true, cache: 'no-store' });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    // Do not display arbitrary provider error text or returned credentials.
    const messages = {
      400: 'Check the endpoint, authentication, and cluster settings.',
      401: 'Sign in again to manage connections.',
      403: 'Connection access is unavailable for this account.',
      404: 'The connection or discovery could not be found.',
      409: 'The connection changed or its previous work is still stopping. Reload its saved settings.',
      413: 'The connection settings are too large.',
      429: 'The saved connection or discovery limit has been reached.',
      503: 'Connection storage is unavailable. Retry to check the saved outcome.',
    };
    const error = new Error(messages[response.status] || 'The connection request failed. Retry to check its outcome.');
    error.status = response.status;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The connection response is invalid. Retry to check its outcome.');
  return value;
}

function profile(value) {
  if (!value || !uuid.test(value.profileId) || !uuid.test(value.revision)
    || !['actual', 'lmstudio'].includes(value.provider) || !['local', 'relay'].includes(value.mode)
    || (value.provider === 'lmstudio' && value.mode !== 'local')
    || typeof value.baseUrl !== 'string' || !['none', 'bearer'].includes(value.authMode)
    || !['ready', 'cleanup-pending'].includes(value.activation)
    || (value.clusterId !== null && typeof value.clusterId !== 'string')) {
    throw new Error('The saved connection response is invalid. Reload to check its state.');
  }
  return value;
}

export async function loadConnections(options) {
  const value = await request(root, options);
  if (!Array.isArray(value.profiles) || value.profiles.length > 128) throw new Error('The connection list is invalid.');
  const profiles = value.profiles.map(profile);
  if (new Set(profiles.map(value => value.profileId)).size !== profiles.length) throw new Error('The connection list is invalid.');
  return profiles;
}
export function validateConnectionReceipt(value, profileId, operationId) {
  if (value.profileId !== profileId || value.operationId !== operationId || value.settingsSaved !== true
    || !uuid.test(value.savedRevision) || typeof value.cleanupConfirmed !== 'boolean' || typeof value.deleted !== 'boolean'
    || (value.deleted ? value.profile !== null : !value.profile)) throw new Error('The save response is invalid. Retry to check its outcome.');
  if (value.profile && (profile(value.profile).profileId !== profileId || value.profile.revision !== value.savedRevision)) {
    throw new Error('The save response does not match the connection. Retry to check its outcome.');
  }
  return value;
}
export async function mutateConnection(mutation, options) {
  const value = await request(`${root}/${id(mutation.profileId)}`, { ...options, method: mutation.method, body: mutation.body });
  return validateConnectionReceipt(value, mutation.profileId, mutation.body.operationId);
}
export async function connectionOperation(profileId, operationId, options) {
  const value = await request(`${root}/${id(profileId)}/operations/${id(operationId)}`, options);
  return validateConnectionReceipt(value, profileId, operationId);
}
export function discoveryPending(job) {
  return !!job && (['queued', 'running', 'cancelling'].includes(job.status) || job.cleanupPending);
}
function discovery(value, requestId, profileId) {
  const nullableBoolean = value => value == null || typeof value === 'boolean';
  const nullableInteger = value => value == null || (Number.isSafeInteger(value) && value >= 0);
  if (value.requestId !== requestId || (profileId && value.profileId !== profileId) || !uuid.test(value.profileId)
    || !['queued', 'running', 'cancelling', 'succeeded', 'empty', 'failed', 'stale', 'cancelled'].includes(value.status)
    || typeof value.cleanupPending !== 'boolean' || typeof value.cancelConfirmed !== 'boolean' || typeof value.cancelRequested !== 'boolean'
    || (value.cancelConfirmed && (value.status !== 'cancelled' || value.cleanupPending || !value.cancelRequested))
    || (value.status === 'cancelled' && (!value.cancelConfirmed || value.cleanupPending || !value.cancelRequested))
    || (value.receipt != null && value.receipt.inferenceVerified !== false)
    || (value.models !== null && (!Array.isArray(value.models) || value.models.length > 1000
      || value.models.some(model => !model || typeof model.id !== 'string' || typeof model.label !== 'string'
        || ![model.loaded, model.available, model.imageInput, model.trainedForTools].every(nullableBoolean)
        || ![model.contextWindow, model.effectiveContext, model.maxOutputTokens].every(nullableInteger))))) {
    throw new Error('The discovery response is invalid. Refresh to check its state.');
  }
  return value;
}
export async function beginConnectionDiscovery(profileId, requestId, options) {
  return discovery(await request(`${root}/${id(profileId)}/discoveries`, { ...options, method: 'POST', body: { requestId } }), requestId, profileId);
}
export async function loadConnectionDiscovery(requestId, options) {
  return discovery(await request(`/api/agent/connection-discoveries/${id(requestId)}`, options), requestId);
}
export async function cancelConnectionDiscovery(profileId, requestId, options) {
  return discovery(await request(`${root}/${id(profileId)}/discoveries/${id(requestId)}/cancel`, { ...options, method: 'POST' }), requestId, profileId);
}

export function connectionDraft(saved) {
  return {
    kind: saved ? `${saved.provider}:${saved.mode}` : 'actual:local',
    baseUrl: saved?.baseUrl || 'http://127.0.0.1:8080/v1',
    authMode: saved?.authMode || 'none', secret: '', clusterId: saved?.clusterId || '',
  };
}
export function canKeepConnectionCredential(draft, saved) {
  if (saved?.authMode !== 'bearer' || draft.kind !== `${saved.provider}:${saved.mode}`) return false;
  try { return new URL(draft.baseUrl.trim()).href.replace(/\/+$/, '') === new URL(saved.baseUrl).href.replace(/\/+$/, ''); }
  catch { return false; }
}
export function connectionBody(draft, saved, operationId) {
  if (!['actual:local', 'actual:relay', 'lmstudio:local'].includes(draft.kind)) throw new Error('Choose a supported provider and mode.');
  const [provider, mode] = draft.kind.split(':');
  const authMode = draft.kind === 'actual:relay' ? 'bearer' : draft.kind === 'actual:local' ? 'none' : draft.authMode;
  const baseUrl = draft.baseUrl.trim();
  let target;
  try { target = new URL(baseUrl); } catch { throw new Error('Enter a full HTTP or HTTPS endpoint ending in /v1.'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash
    || !target.pathname.replace(/\/+$/, '').endsWith('/v1') || /[\p{Cc}]/u.test(baseUrl) || baseUrl.includes('?') || baseUrl.includes('#') || baseUrl.includes('\\') || target.port === '0' || Array.from(baseUrl).length > 2048 || baseUrl.split('://')[1]?.split('/')[0].includes('@')) {
    throw new Error('Use an HTTP or HTTPS endpoint ending in /v1, without credentials, queries, or fragments.');
  }
  if (mode === 'local' && !(target.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(target.hostname))) throw new Error('Local profiles require a literal loopback IP such as 127.0.0.1 or [::1].');
  if (mode === 'relay' && target.protocol !== 'https:') throw new Error('Actual relay requires HTTPS.');
  if (mode === 'relay' && target.href.replace(/\/+$/, '') !== 'https://api.actual.inc/v1') throw new Error('Actual relay uses https://api.actual.inc/v1. Use Actual local for a local server.');
  if (authMode === 'bearer' && !draft.secret && saved?.authMode !== 'bearer') throw new Error('Enter a bearer key for this connection.');
  if (authMode === 'bearer' && !draft.secret && saved && !canKeepConnectionCredential(draft, saved)) throw new Error('Enter a replacement bearer key when changing the provider or endpoint.');
  if (draft.secret && (draft.secret.trim() !== draft.secret || /[\p{Cc}]/u.test(draft.secret))) throw new Error('The bearer key must not contain surrounding spaces or control characters.');
  return {
    operationId, expectedRevision: saved?.revision || null, provider, mode, baseUrl,
    auth: authMode === 'none' ? { type: 'none' } : draft.secret
      ? { type: 'bearer', credentialAction: 'replace', secret: draft.secret }
      : { type: 'bearer', credentialAction: 'keep' },
    clusterId: provider === 'actual' && mode === 'relay' ? draft.clusterId.trim() || null : null,
  };
}
