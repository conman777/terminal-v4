export function validProjectFilePath(path, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/')
    || /[\x00-\x1f\x7f-\x9f]/.test(workspaceRoot)
    || typeof path !== 'string' || !path || path.startsWith('/')
    || /[\\\x00-\x1f\x7f-\x9f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  try { return new TextEncoder().encode(path).length <= 2048 && decodeURIComponent(encodeURIComponent(path)) === path; }
  catch { return false; }
}

export function projectFileReference(value, workspaceRoot) {
  if (typeof value !== 'string' || !value || value.length > 2048 || typeof workspaceRoot !== 'string'
    || !workspaceRoot.startsWith('/') || /[\\\x00-\x1f\x7f%?]/.test(value)) return null;
  const root = workspaceRoot === '/' ? '/' : workspaceRoot.replace(/\/+$/, '');
  let path = value;
  let line = 1;
  const suffix = path.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L(\d+))?)$/i);
  if (suffix) {
    line = Number(suffix[1] || suffix[3]);
    const end = suffix[2] || suffix[4];
    if (end && (!Number.isSafeInteger(Number(end)) || Number(end) < 1 || Number(end) > 1_000_000
      || suffix[4] && Number(end) < line)) return null;
    path = path.slice(0, suffix.index);
  }
  if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000 || path.includes('#')) return null;
  if (path.startsWith('/')) {
    const prefix = root === '/' ? '/' : `${root}/`;
    if (!path.startsWith(prefix)) return null;
    path = path.slice(prefix.length);
  } else if (path.startsWith('./')) path = path.slice(2);
  if (!path || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')
    || !suffix && !path.includes('/') && !path.includes('.')) return null;
  return { path, line };
}
