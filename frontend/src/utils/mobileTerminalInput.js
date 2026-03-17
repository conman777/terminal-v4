export function quoteTerminalPath(path) {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  if (!trimmed) return '';
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

export function buildTerminalAttachmentPrefix(paths) {
  if (!Array.isArray(paths)) return '';
  return paths
    .map((path) => quoteTerminalPath(path))
    .filter(Boolean)
    .join(' ')
    .trim();
}
