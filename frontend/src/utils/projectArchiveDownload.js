import { resolveApiUrl } from './apiBase';
import { getAccessToken } from './auth';

export function downloadProjectArchive(projectPath) {
  const normalizedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedPath) return false;

  const params = new URLSearchParams({ path: normalizedPath });
  const token = getAccessToken();
  if (token) {
    params.set('token', token);
  }

  window.location.href = resolveApiUrl(`/api/fs/download?${params.toString()}`);
  return true;
}
