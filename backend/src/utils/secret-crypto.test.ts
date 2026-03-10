import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-crypto';

describe('secret-crypto', () => {
  it('encrypts and decrypts secrets', () => {
    const plaintext = 'sk-live-test-secret';
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('passes through legacy plaintext values', () => {
    expect(decryptSecret('legacy-secret')).toBe('legacy-secret');
    expect(isEncryptedSecret('legacy-secret')).toBe(false);
  });
});
