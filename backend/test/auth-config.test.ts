import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('auth config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.REFRESH_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('accepts JWT_REFRESH_SECRET alias in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'legacy-refresh-secret';

    const { assertAuthConfig } = await import('../src/auth/auth-service.js');

    expect(() => assertAuthConfig()).not.toThrow();
  });

  it('requires refresh secret in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-jwt-secret';

    const { assertAuthConfig } = await import('../src/auth/auth-service.js');

    expect(() => assertAuthConfig()).toThrow('REFRESH_SECRET must be set to a strong value in production');
  });
});
