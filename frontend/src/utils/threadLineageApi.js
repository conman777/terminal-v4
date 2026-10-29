import { apiFetch } from './api';

export async function recordThreadLineage(childId, parentId, kind) {
  try {
    const response = await apiFetch('/api/thread-lineage', { method: 'PUT', body: { childId, parentId, kind } });
    return response.ok === true;
  } catch {
    return false;
  }
}
