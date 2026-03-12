export function focusElementWithoutScroll(element) {
  if (!element || typeof element.focus !== 'function') {
    return false;
  }

  try {
    element.focus({ preventScroll: true });
    return true;
  } catch {
    element.focus();
    return true;
  }
}
