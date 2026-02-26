import { getDatabase } from '../database/db.js';
import { randomUUID } from 'crypto';

export interface PasskeyCredential {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  device_type: string;
  backed_up: number;
  transports: string | null;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatePasskeyCredentialData {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports?: string[];
  name?: string;
}

export function createPasskeyCredential(userId: string, data: CreatePasskeyCredentialData): PasskeyCredential {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    data.credentialId,
    Buffer.from(data.publicKey),
    data.counter,
    data.deviceType,
    data.backedUp ? 1 : 0,
    data.transports ? JSON.stringify(data.transports) : null,
    data.name || null,
    now
  );

  return {
    id,
    user_id: userId,
    credential_id: data.credentialId,
    public_key: Buffer.from(data.publicKey),
    counter: data.counter,
    device_type: data.deviceType,
    backed_up: data.backedUp ? 1 : 0,
    transports: data.transports ? JSON.stringify(data.transports) : null,
    name: data.name || null,
    created_at: now,
    last_used_at: null
  };
}

export function getPasskeyCredentialByCredentialId(credentialId: string): PasskeyCredential | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?').get(credentialId) as PasskeyCredential | undefined;
}

export function getPasskeyCredentialsByUserId(userId: string): PasskeyCredential[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC').all(userId) as PasskeyCredential[];
}

export function updatePasskeyCredentialCounter(id: string, counter: number, lastUsedAt: string): void {
  const db = getDatabase();
  db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, lastUsedAt, id);
}

export function deletePasskeyCredential(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM passkey_credentials WHERE id = ?').run(id);
}
