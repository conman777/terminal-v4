import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Bytes, sha256Hex } from './sha256';

afterEach(() => vi.unstubAllGlobals());

describe('SHA-256 on secure and non-secure origins', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('matches the standard vector %s without SubtleCrypto', async (input, expected) => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    expect(await sha256Hex(new TextEncoder().encode(input))).toBe(expected);
  });

  it('matches native SHA-256 for large binary image data and preserves the input', async () => {
    const image = new Uint8Array(8 * 1024 * 1024);
    for (let index = 0; index < image.length; index += 1) image[index] = index % 251;
    const expected = createHash('sha256').update(image).digest('hex');
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    expect(await sha256Hex(image)).toBe(expected);
    expect(image[65536]).toBe(65536 % 251);
    vi.stubGlobal('crypto', webcrypto);
    expect(Buffer.from(await sha256Bytes(image)).toString('hex')).toBe(expected);
  });
});
