import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1';
const ALGORITHM = 'aes-256-gcm';

const DEV_VAULT_KEY = 'dev-vault-key-change-me';
let warnedDevKey = false;

function getEncryptionKey(): Buffer {
  const vaultKey = process.env.VAULT_ENCRYPTION_KEY;
  if (vaultKey) {
    return createHash('sha256').update(vaultKey).digest();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('VAULT_ENCRYPTION_KEY must be set in production');
  }

  if (!warnedDevKey) {
    console.warn('[secret-crypto] VAULT_ENCRYPTION_KEY not set — using insecure dev fallback');
    warnedDevKey = true;
  }
  return createHash('sha256').update(DEV_VAULT_KEY).digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(':');
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(`${ENCRYPTION_PREFIX}:`)) {
    return value;
  }

  const [, , ivBase64, tagBase64, encryptedBase64] = value.split(':');
  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Invalid encrypted secret format');
  }

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${ENCRYPTION_PREFIX}:`);
}
