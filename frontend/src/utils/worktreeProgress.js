import { apiFetch } from './api';

const BASE = '/api/workspace/git/worktrees';
const STAGE_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'warning', 'skipped', 'cancelled']);
const RUN_STATUSES = new Set(['running', 'ready', 'failed', 'cancelled']);

export function parseWorktreeProgress(value) {
  if (!value || typeof value !== 'object' || !RUN_STATUSES.has(value.status) || !Array.isArray(value.stages)) return null;
  return {
    status: value.status,
    cancelling: value.cancelling === true,
    stages: value.stages.filter(stage => stage && typeof stage.id === 'string' && STAGE_STATUSES.has(stage.status)).map(stage => ({
      id: stage.id, label: String(stage.label || stage.id), status: stage.status, detail: typeof stage.detail === 'string' ? stage.detail : '',
    })),
    tail: Array.isArray(value.tail) ? value.tail.filter(line => typeof line === 'string').slice(-20) : [],
    elapsedMs: Number.isFinite(value.elapsedMs) ? value.elapsedMs : 0,
    error: typeof value.error === 'string' ? value.error : '',
    cleanup: typeof value.cleanup === 'string' ? value.cleanup : '',
    cleaned: typeof value.cleaned === 'boolean' ? value.cleaned : null,
  };
}

export async function fetchWorktreeProgress(operationId, signal) {
  const response = await apiFetch(`${BASE}/progress?operationId=${encodeURIComponent(operationId)}`, { signal });
  if (!response?.ok) return null;
  return parseWorktreeProgress(await response.json().catch(() => null));
}

export async function cancelWorktreeCreation(operationId) {
  const response = await apiFetch(`${BASE}/cancel`, { method: 'POST', body: { operationId } });
  return response?.ok ? parseWorktreeProgress(await response.json().catch(() => null)) : null;
}

export async function discardUnfinishedWorktree(path, operationId) {
  const response = await apiFetch(`${BASE}/discard`, { method: 'POST', body: { path, worktreeId: operationId } });
  if (response?.ok) return { discarded: true };
  const body = await response?.json?.().catch(() => null);
  return { discarded: false, error: body?.error || 'The unfinished checkout could not be removed.' };
}
