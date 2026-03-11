import { describe, expect, it } from 'vitest';
import { loginSchema } from './auth-schemas';

describe('loginSchema', () => {
  it('accepts username-based login payloads', () => {
    expect(loginSchema.parse({ username: 'conor', password: 'secret' })).toEqual({
      username: 'conor',
      password: 'secret'
    });
  });

  it('accepts legacy email-based login payloads', () => {
    expect(loginSchema.parse({ email: 'conor@example.com', password: 'secret' })).toEqual({
      username: 'conor@example.com',
      password: 'secret'
    });
  });
});
