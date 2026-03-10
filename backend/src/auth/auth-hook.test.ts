import { describe, expect, it } from 'vitest';
import { isPublicApiRoute } from './auth-hook';

describe('isPublicApiRoute', () => {
  it('matches exact public routes and ignores query strings', () => {
    expect(isPublicApiRoute('/api/auth/register')).toBe(true);
    expect(isPublicApiRoute('/api/auth/register?source=test')).toBe(true);
  });

  it('does not allow prefix matches for non-public routes', () => {
    expect(isPublicApiRoute('/api/auth/register-passkey')).toBe(false);
  });

  it('matches public route patterns', () => {
    expect(isPublicApiRoute('/api/browser/snapshot')).toBe(true);
  });
});
