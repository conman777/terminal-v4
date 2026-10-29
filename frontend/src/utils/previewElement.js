function plainText(value, limit = 5000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid preview text');
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function plainRecord(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview values');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('Too many preview values');
  return Object.fromEntries(entries.map(([key, item]) => [plainText(key, 256), plainText(item)]));
}

export function normalizePreviewElement(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const element = Object.fromEntries(['elementId', 'tagName', 'id', 'className', 'selector', 'fullSelector', 'outerHTML', 'textContent']
      .map(key => [key, plainText(value[key])]));
    if (!element.selector && !element.fullSelector && !element.tagName) return null;
    if (value.rect != null && (typeof value.rect !== 'object' || Array.isArray(value.rect))) return null;
    element.rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => {
      const number = value.rect?.[key] ?? 0;
      if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 10000000) throw new Error('Invalid preview dimensions');
      return [key, number];
    }));
    for (const key of ['attributes', 'computedStyle', 'extendedStyles']) element[key] = plainRecord(value[key]);
    if (value.parentChain != null && (!Array.isArray(value.parentChain) || value.parentChain.length > 10)) return null;
    element.parentChain = (value.parentChain || []).map(parent => Object.fromEntries(
      ['tagName', 'id', 'className', 'selector'].map(key => [key, plainText(parent[key])])));
    if (value.react) {
      if (typeof value.react !== 'object' || Array.isArray(value.react)) return null;
      element.react = Object.fromEntries(['componentName', 'filePath'].map(key => [key, plainText(value.react[key])]));
      const props = value.react.props || {};
      if (typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length > 100) return null;
      element.react.props = Object.fromEntries(Object.entries(props).map(([key, item]) => {
        if (item != null && !['string', 'boolean', 'number'].includes(typeof item)) throw new Error('Invalid preview prop');
        return [plainText(key, 256), plainText(String(item))];
      }));
    }
    if (JSON.stringify(element).length > 50000) return null;
    return element;
  } catch {
    return null;
  }
}
