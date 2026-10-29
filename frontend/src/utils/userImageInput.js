// This projection belongs only to the owned image-send route. Legacy text sends
// retain their existing trim/newline protocol. Do not project a frozen retry.
const EDGE_SPACE = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FIELDS = ['attachmentId', 'artifactId', 'mimeType', 'bytes', 'name'];
const encodedBytes = text => new TextEncoder().encode(text).length;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

export function projectImageText(raw) {
  if (typeof raw !== 'string') throw new Error('Image message text must be a string.');
  return raw.replace(/\r\n/g, '\n').replace(EDGE_SPACE, '');
}

export function cloneImageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 8) throw new Error('An image message requires 1 to 8 ready image references.');
  let total = 0;
  const copies = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const value = attachments[index];
    if (!Object.prototype.hasOwnProperty.call(attachments, index) || !exactKeys(value, FIELDS) || typeof value.attachmentId !== 'string' || !UUID.test(value.attachmentId)
      || typeof value.artifactId !== 'string' || !HASH.test(value.artifactId)
      || !IMAGE_TYPES.has(value.mimeType) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 8 * 1024 * 1024
      || typeof value.name !== 'string' || encodedBytes(value.name) < 1 || encodedBytes(value.name) > 255 || /[\u0000-\u001f\u007f-\u009f/\\]/.test(value.name)) {
      throw new Error('A ready image reference has invalid metadata. Reattach the image before sending.');
    }
    total += value.bytes;
    copies.push(Object.freeze({ attachmentId: value.attachmentId, artifactId: value.artifactId, mimeType: value.mimeType, bytes: value.bytes, name: value.name }));
  }
  if (total > 16 * 1024 * 1024) throw new Error('An image message exceeds the 16 MiB image byte limit.');
  return Object.freeze(copies);
}

export function projectImageInput(raw, attachments) {
  return Object.freeze({ text: projectImageText(raw), attachments: cloneImageAttachments(attachments) });
}

export function sameImageInput(left, right) {
  if (!exactKeys(left, ['text', 'attachments']) || !exactKeys(right, ['text', 'attachments'])
    || typeof left.text !== 'string' || left.text !== right.text) return false;
  try {
    const a = cloneImageAttachments(left.attachments), b = cloneImageAttachments(right.attachments);
    return a.length === b.length && a.every((value, index) => FIELDS.every(field => value[field] === b[index][field]));
  } catch { return false; }
}
