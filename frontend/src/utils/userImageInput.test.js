import { describe, expect, it } from 'vitest';
import { cloneImageAttachments, projectImageInput, projectImageText, sameImageInput } from './userImageInput';

const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'Cafe\u0301.png' };
const B = { attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: 'b'.repeat(64), mimeType: 'image/webp', bytes: 68, name: 'second.webp' };

describe('owned user image input metadata', () => {
  it('uses the declared Rust whitespace set, including NEL, at boundaries only', () => {
    const boundary = '\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
    expect(projectImageText(boundary + 'inside\u0085text' + boundary)).toBe('inside\u0085text');
  });
  it('retains BOM and a BOM boundary prevents trimming NEL behind it', () => {
    expect(projectImageText('\u0085\ufefftext\ufeff\u0085')).toBe('\ufefftext\ufeff');
    expect(projectImageText('\ufeff\u0085text\u0085\ufeff')).toBe('\ufeff\u0085text\u0085\ufeff');
  });
  it('maps only CRLF pairs and never normalizes accents or appends a transport newline', () => {
    const raw = ' \tCafe\u0301\r\nx\ry \n';
    expect(projectImageText(raw)).toBe('Cafe\u0301\nx\ry'); expect(raw).toBe(' \tCafe\u0301\r\nx\ry \n');
  });
  it('snapshots ordered complete descriptors without mutating names or the caller array', () => {
    const refs = [{ ...A }, { ...B }, { ...A }], projected = projectImageInput('', refs);
    refs[0].name = 'later.png'; refs.reverse();
    expect(projected).toEqual({ text: '', attachments: [A, B, A] });
    expect(Object.isFrozen(projected)).toBe(true); expect(Object.isFrozen(projected.attachments)).toBe(true); expect(Object.isFrozen(projected.attachments[0])).toBe(true);
  });
  it('counts every ordered occurrence against8refs and16MiB even when image bytes deduplicate', () => {
    expect(cloneImageAttachments(Array.from({ length: 8 }, () => ({ ...A, bytes: 2 * 1024 * 1024 })))).toHaveLength(8);
    expect(() => cloneImageAttachments(Array.from({ length: 9 }, () => A))).toThrow();
    expect(() => cloneImageAttachments([{ ...A, bytes: 8 * 1024 * 1024 }, { ...A, bytes: 8 * 1024 * 1024 }, A])).toThrow();
  });
  it.each([
    ['noncanonical UUID', { ...A, attachmentId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' }],
    ['boxed UUID', { ...A, attachmentId: new String(A.attachmentId) }],
    ['boxed artifact hash', { ...A, artifactId: new String(A.artifactId) }],
    ['artifact hash', { ...A, artifactId: 'A'.repeat(64) }],
    ['MIME', { ...A, mimeType: 'text/plain' }],
    ['zero bytes', { ...A, bytes: 0 }],
    ['fractional bytes', { ...A, bytes: 1.5 }],
    ['oversized bytes', { ...A, bytes: 8 * 1024 * 1024 + 1 }],
    ['extra path', { ...A, path: '/synthetic/not-authority.png' }],
    ['empty name', { ...A, name: '' }],
    ['slash name', { ...A, name: 'nested/name.png' }],
    ['backslash name', { ...A, name: 'nested\\name.png' }],
    ['C1 control name', { ...A, name: 'name\u0085.png' }],
    ['UTF8 name budget', { ...A, name: '😀'.repeat(64) }],
  ])('rejects invalid %s metadata without accepting a partial reference', (_label, descriptor) => {
    expect(() => cloneImageAttachments([descriptor])).toThrow();
  });
  it('requires a nonempty image manifest and compares exact echoes without projection or reordering', () => {
    expect(() => cloneImageAttachments([])).toThrow();
    const expected = projectImageInput(' \u0085raw\r\ntext ', [A, B]);
    expect(sameImageInput({ attachments: [{ name: A.name, bytes: A.bytes, mimeType: A.mimeType, artifactId: A.artifactId, attachmentId: A.attachmentId }, B], text: expected.text }, expected)).toBe(true);
    for (const changed of [{ text: expected.text + '\n', attachments: [A, B] }, { text: expected.text, attachments: [B, A] }, { text: expected.text, attachments: [{ ...A, name: 'Caf\u00e9.png' }, B] }, { ...expected, extra: true }]) expect(sameImageInput(changed, expected)).toBe(false);
  });
});
