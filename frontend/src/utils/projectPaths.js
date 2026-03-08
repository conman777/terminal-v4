export function normalizeProjectPath(path) {
  if (!path) return '';
  return String(path)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
