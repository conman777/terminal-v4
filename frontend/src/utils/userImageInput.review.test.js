import { describe, expect, it } from 'vitest';
import { cloneImageAttachments, sameImageInput } from './userImageInput';

const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const B = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/webp', bytes: 68, name: 'second.webp' };
const shapes = [
  ['leading hole', () => [, A], [B, A]],
  ['middle hole', () => [A, , B], [A, A, B]],
  ['all holes', () => Array(1), [A]],
];

describe('image manifest dense-position validation', () => {
  it.each(shapes)('rejects a %s rather than persisting a null descriptor', (_label, sparse) => {
    expect(() => cloneImageAttachments(sparse())).toThrow(/image|reference|metadata/i);
  });
  it.each(shapes)('does not equate a %s on the left with a complete manifest', (_label, sparse, dense) => {
    expect(sameImageInput({ text: 'Exact input', attachments: sparse() }, { text: 'Exact input', attachments: dense })).toBe(false);
  });
  it.each(shapes)('does not equate a %s on the right with a complete manifest', (_label, sparse, dense) => {
    expect(sameImageInput({ text: 'Exact input', attachments: dense }, { text: 'Exact input', attachments: sparse() })).toBe(false);
  });
});
