import { getDatabase } from '../database/db.js';
import { randomUUID } from 'crypto';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface UserPublic {
  id: string;
  username: string;
  created_at: string;
}

export function createUser(username: string, passwordHash: string): User {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO users (id, username, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, username, passwordHash, now, now);

  return {
    id,
    username,
    password_hash: passwordHash,
    created_at: now,
    updated_at: now
  };
}

export function getUserByUsername(username: string): User | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function getUserById(id: string): User | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function toPublicUser(user: User): UserPublic {
  return {
    id: user.id,
    username: user.username,
    created_at: user.created_at
  };
}

// Refresh token management
export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export function createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): RefreshToken {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, tokenHash, expiresAt.toISOString(), now);

  return {
    id,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    created_at: now
  };
}

export function getRefreshTokenByHash(tokenHash: string): RefreshToken | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as RefreshToken | undefined;
}

export function deleteRefreshToken(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
}

export function deleteUserRefreshTokens(userId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

export function deleteExpiredRefreshTokens(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(new Date().toISOString());
}
