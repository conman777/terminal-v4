import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn()
  }
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(() => 'access-token')
  }
}));

vi.mock('./neon-user-store.js', () => ({
  getNeonUserByIdentifier: vi.fn(),
  getNeonUserById: vi.fn()
}));

vi.mock('./user-store.js', () => ({
  EXTERNAL_AUTH_MIRROR_PASSWORD_HASH: '!external-auth-mirror!',
  getUserByUsername: vi.fn(),
  getUserById: vi.fn(),
  isExternalAuthMirrorUser: vi.fn(),
  toPublicUser: vi.fn((user) => ({
    id: user.id,
    username: user.username,
    created_at: user.created_at
  })),
  upsertExternalAuthMirrorUser: vi.fn(),
  createRefreshToken: vi.fn(),
  getRefreshTokenByHash: vi.fn(),
  deleteRefreshToken: vi.fn(),
  deleteUserRefreshTokens: vi.fn(),
  deleteExpiredRefreshTokens: vi.fn()
}));

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { login, refreshTokens } from './auth-service';
import { getNeonUserByIdentifier, getNeonUserById } from './neon-user-store.js';
import {
  getUserByUsername,
  createRefreshToken,
  deleteExpiredRefreshTokens,
  deleteRefreshToken,
  getRefreshTokenByHash,
  getUserById,
  isExternalAuthMirrorUser,
  upsertExternalAuthMirrorUser
} from './user-store.js';

describe('auth-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isExternalAuthMirrorUser).mockReturnValue(false);
  });

  it('prefers local username accounts before Neon lookup', async () => {
    vi.mocked(getUserByUsername).mockReturnValue({
      id: 'local-user-1',
      username: 'conor',
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z',
      updated_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await login('conor', 'secret');

    expect(getNeonUserByIdentifier).not.toHaveBeenCalled();
    expect(result.user.username).toBe('conor');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'local-user-1', username: 'conor' }),
      expect.any(String),
      expect.any(Object)
    );
  });

  it('logs in with a username-style identifier and returns display name as username', async () => {
    vi.mocked(getUserByUsername).mockReturnValue(undefined);
    vi.mocked(getNeonUserByIdentifier).mockResolvedValue({
      id: 'user-1',
      email: 'conor@example.com',
      display_name: 'conor',
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await login('conor', 'secret');

    expect(getNeonUserByIdentifier).toHaveBeenCalledWith('conor');
    expect(result.user.username).toBe('conor');
    expect(result.tokens.accessToken).toBe('access-token');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', username: 'conor' }),
      expect.any(String),
      expect.any(Object)
    );
    expect(upsertExternalAuthMirrorUser).toHaveBeenCalledWith('user-1', 'conor');
    expect(createRefreshToken).toHaveBeenCalled();
  });

  it('falls back to email when no display name exists', async () => {
    vi.mocked(getUserByUsername).mockReturnValue(undefined);
    vi.mocked(getNeonUserByIdentifier).mockResolvedValue({
      id: 'user-2',
      email: 'conor@example.com',
      display_name: null,
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await login('conor@example.com', 'secret');

    expect(result.user.username).toBe('conor@example.com');
  });

  it('preserves the resolved username when refreshing tokens', async () => {
    vi.mocked(getRefreshTokenByHash).mockReturnValue({
      id: 'rt-1',
      user_id: 'user-1',
      token_hash: 'hash',
      expires_at: '2999-01-01T00:00:00.000Z',
      created_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(getNeonUserById).mockResolvedValue({
      id: 'user-1',
      email: 'conor@example.com',
      display_name: 'conor',
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z'
    });

    const result = await refreshTokens('refresh-token');

    expect(deleteExpiredRefreshTokens).toHaveBeenCalled();
    expect(deleteRefreshToken).toHaveBeenCalledWith('rt-1');
    expect(result.user.username).toBe('conor');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', username: 'conor' }),
      expect.any(String),
      expect.any(Object)
    );
    expect(upsertExternalAuthMirrorUser).toHaveBeenCalledWith('user-1', 'conor');
  });

  it('refreshes local-user sessions from SQLite-backed users', async () => {
    vi.mocked(getRefreshTokenByHash).mockReturnValue({
      id: 'rt-2',
      user_id: 'local-user-1',
      token_hash: 'hash',
      expires_at: '2999-01-01T00:00:00.000Z',
      created_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(getUserById).mockReturnValue({
      id: 'local-user-1',
      username: 'conor',
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z',
      updated_at: '2026-03-11T00:00:00.000Z'
    });

    const result = await refreshTokens('refresh-token');

    expect(getNeonUserById).not.toHaveBeenCalled();
    expect(result.user.username).toBe('conor');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'local-user-1', username: 'conor' }),
      expect.any(String),
      expect.any(Object)
    );
  });

  it('skips mirror rows during username login and falls through to Neon auth', async () => {
    vi.mocked(getUserByUsername).mockReturnValue({
      id: 'user-1',
      username: 'conor',
      password_hash: '!external-auth-mirror!',
      created_at: '2026-03-11T00:00:00.000Z',
      updated_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(isExternalAuthMirrorUser).mockReturnValue(true);
    vi.mocked(getNeonUserByIdentifier).mockResolvedValue({
      id: 'user-1',
      email: 'conor@example.com',
      display_name: 'conor',
      password_hash: 'hash',
      created_at: '2026-03-11T00:00:00.000Z'
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await login('conor', 'secret');

    expect(getNeonUserByIdentifier).toHaveBeenCalledWith('conor');
    expect(result.user.username).toBe('conor');
  });
});
