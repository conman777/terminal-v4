import { describe, expect, it } from 'vitest';
import { shouldExclude } from './webcontainer-routes';

describe('shouldExclude', () => {
  it('excludes env local variants matched by wildcard patterns', () => {
    expect(shouldExclude('.env.production.local')).toBe(true);
    expect(shouldExclude('.env.development.local')).toBe(true);
  });

  it('excludes suffix wildcard matches', () => {
    expect(shouldExclude('server.log')).toBe(true);
    expect(shouldExclude('Cargo.lock')).toBe(true);
  });

  it('keeps allowed dotfiles and non-matching env files', () => {
    expect(shouldExclude('.gitignore')).toBe(false);
    expect(shouldExclude('.env')).toBe(false);
  });
});
