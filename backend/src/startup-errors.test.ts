import { describe, expect, it } from 'vitest';
import { formatStartupErrorMessage } from './startup-errors';

describe('formatStartupErrorMessage', () => {
  it('returns a clear message for port collisions', () => {
    const message = formatStartupErrorMessage({
      code: 'EADDRINUSE',
      port: 3020,
      address: '0.0.0.0'
    });

    expect(message).toBe('Port 3020 is already in use on 0.0.0.0. Stop the existing process or set PORT to a different value.');
  });

  it('falls back to the default message for unknown startup errors', () => {
    const message = formatStartupErrorMessage(new Error('boom'));

    expect(message).toBe('Failed to start server');
  });
});
