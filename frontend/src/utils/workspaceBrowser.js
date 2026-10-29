export function browserAddress(value) {
  const text = value.trim();
  if (!text) throw new Error('Enter a website address or search.');
  if (/\s/.test(text) && !/^[a-z][a-z\d+.-]*:/i.test(text)) return 'https://www.google.com/search?q=' + encodeURIComponent(text);
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(file|javascript|data|about|chrome):/i.test(text);
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:|\/|$)/i.test(text);
  const url = new URL(explicit ? text : `${local ? 'http' : 'https'}://${text}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}

export function browserPoint(rect, width, height, clientX, clientY) {
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!(scale > 0)) return null;
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  return x >= 0 && x <= width && y >= 0 && y <= height ? { x, y } : null;
}
