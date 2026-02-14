import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hashPasswordMock, createUserMock, getUserCountMock } = vi.hoisted(() => ({
  hashPasswordMock: vi.fn(async () => 'hashed-password'),
  createUserMock: vi.fn(() => ({
    id: 'bootstrap-user-id',
    username: 'dev',
    password_hash: 'hashed-password',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })),
  getUserCountMock: vi.fn(() => 0)
}));

vi.mock('../src/auth/auth-service.js', () => ({
  hashPassword: hashPasswordMock
}));

vi.mock('../src/auth/user-store.js', () => ({
  createUser: createUserMock,
  getUserCount: getUserCountMock
}));

import { ensureDevBootstrapUser } from '../src/auth/dev-bootstrap.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn()
};

describe('ensureDevBootstrapUser', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEV_BOOTSTRAP_USER_ENABLED;
    delete process.env.DEV_BOOTSTRAP_USERNAME;
    delete process.env.DEV_BOOTSTRAP_PASSWORD;
    delete process.env.ALLOWED_USERNAME;
    delete process.env.NODE_ENV;
    vi.clearAllMocks();
    getUserCountMock.mockReturnValue(0);
  });

  it('does not bootstrap in production', async () => {
    process.env.NODE_ENV = 'production';

    await ensureDevBootstrapUser(logger);

    expect(getUserCountMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(hashPasswordMock).not.toHaveBeenCalled();
  });

  it('does not bootstrap in test', async () => {
    process.env.NODE_ENV = 'test';

    await ensureDevBootstrapUser(logger);

    expect(getUserCountMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('does not bootstrap when disabled explicitly', async () => {
    process.env.DEV_BOOTSTRAP_USER_ENABLED = 'false';

    await ensureDevBootstrapUser(logger);

    expect(getUserCountMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('does not create user when users already exist', async () => {
    getUserCountMock.mockReturnValue(2);

    await ensureDevBootstrapUser(logger);

    expect(getUserCountMock).toHaveBeenCalledTimes(1);
    expect(createUserMock).not.toHaveBeenCalled();
    expect(hashPasswordMock).not.toHaveBeenCalled();
  });

  it('creates default bootstrap user when database is empty', async () => {
    await ensureDevBootstrapUser(logger);

    expect(getUserCountMock).toHaveBeenCalledTimes(1);
    expect(hashPasswordMock).toHaveBeenCalledWith('dev-password');
    expect(createUserMock).toHaveBeenCalledWith('dev', 'hashed-password');
    expect(logger.info).toHaveBeenCalledWith('[auth] Created development bootstrap user "dev"');
    expect(logger.warn).toHaveBeenCalledWith('[auth] Development login credentials -> username: dev password: dev-password');
  });

  it('uses ALLOWED_USERNAME when provided', async () => {
    process.env.ALLOWED_USERNAME = 'conor';

    await ensureDevBootstrapUser(logger);

    expect(createUserMock).toHaveBeenCalledWith('conor', 'hashed-password');
  });

  it('uses explicit DEV_BOOTSTRAP credentials when configured', async () => {
    process.env.DEV_BOOTSTRAP_USERNAME = 'owner';
    process.env.DEV_BOOTSTRAP_PASSWORD = 'owner-pass';
    process.env.ALLOWED_USERNAME = 'ignored-allowed-user';

    await ensureDevBootstrapUser(logger);

    expect(hashPasswordMock).toHaveBeenCalledWith('owner-pass');
    expect(createUserMock).toHaveBeenCalledWith('owner', 'hashed-password');
  });
});
