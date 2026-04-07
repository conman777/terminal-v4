import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, resolveApiBase, resolveApiUrl } from './apiBase';

describe('apiBase', () => {
  it('detects loopback hostnames', () => {
    expect([
      isLoopbackHostname('localhost'),
      isLoopbackHostname('127.0.0.1'),
      isLoopbackHostname('::1'),
      isLoopbackHostname('[::1]'),
      isLoopbackHostname('example.com')
    ]).toEqual([true, true, true, true, false]);
  });

  it('rewrites configured loopback hosts to the active browser loopback host', () => {
    const locationLike = {
      origin: 'http://127.0.0.1:5175',
      hostname: '127.0.0.1'
    };

    expect(resolveApiBase('http://localhost:3020', locationLike)).toBe('http://127.0.0.1:5175');
  });

  it('preserves non-loopback configured hosts', () => {
    const locationLike = {
      origin: 'http://127.0.0.1:5175',
      hostname: '127.0.0.1'
    };

    expect(resolveApiBase('https://api.example.com/base/', locationLike)).toBe('https://api.example.com/base');
    expect(resolveApiUrl('/api/auth/login', 'https://api.example.com/base/', locationLike))
      .toBe('https://api.example.com/base/api/auth/login');
  });
});
