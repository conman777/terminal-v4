import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from './createUuid';

afterEach(() => vi.unstubAllGlobals());

describe('createUuid', () => {
  it('uses the native UUID implementation when available', () => {
    const expected = '01234567-89ab-4cde-8f01-23456789abcd';
    vi.stubGlobal('crypto', { randomUUID() { return this.expected; }, expected });
    expect(createUuid()).toBe(expected);
  });

  it('sets UUID v4 version and variant bits from cryptographic random bytes without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: bytes => bytes.fill(255) });
    expect(createUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('generates distinct valid UUIDs with the HTTP browser crypto API', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 128 }, createUuid);
    expect(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) && new Set(ids).size === ids.length).toBe(true);
  });
});
