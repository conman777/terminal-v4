function nameParts(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function projectNameFromPath(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function getProjectBadge(name) {
  const parts = nameParts(name);
  const initials = parts.length === 0 ? '?'
    : parts.length === 1 ? parts[0].slice(0, 2)
      : parts[0][0] + parts[1][0];
  let hash = 0;
  for (const char of String(name || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return { initials: initials.toUpperCase(), hue: hash % 360 };
}
