export function desktopPoint(rect, clientX, clientY) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height, clientX, clientY].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export function desktopKey(event) {
  const allowed = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Enter|Escape|Tab|Backspace|Delete|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Insert)$/;
  if (!allowed.test(event.code)) return null;
  return { kind: 'key', key: event.code, modifiers: [['ctrlKey', 'Control'], ['altKey', 'Alt'], ['shiftKey', 'Shift'], ['metaKey', 'Meta']].filter(([flag]) => event[flag]).map(([, key]) => key) };
}
