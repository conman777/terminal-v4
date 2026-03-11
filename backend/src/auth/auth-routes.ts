import type { FastifyInstance } from 'fastify';
import { login, refreshTokens, logout } from './auth-service.js';
import { loginSchema, refreshSchema } from './auth-schemas.js';
import { ZodError } from 'zod';

export function registerAuthRoutes(app: FastifyInstance): void {
  // Register - disabled, users are managed in the Neon database
  app.post('/api/auth/register', async (_request, reply) => {
    reply.status(403).send({ error: 'Registration is disabled. Users are managed externally.' });
  });

  // Login
  app.post<{ Body: { username?: string; email?: string; password: string } }>('/api/auth/login', async (request, reply) => {
    try {
      const input = loginSchema.parse(request.body);
      const result = await login(input.username, input.password);
      reply.send(result);
    } catch (error) {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'Validation error',
          details: error.errors
        });
        return;
      }
      if (error instanceof Error && error.message === 'Invalid credentials') {
        reply.status(401).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // Refresh tokens
  app.post<{ Body: { refreshToken: string } }>('/api/auth/refresh', async (request, reply) => {
    try {
      const input = refreshSchema.parse(request.body);
      const result = await refreshTokens(input.refreshToken);
      reply.send(result);
    } catch (error) {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'Validation error',
          details: error.errors
        });
        return;
      }
      if (error instanceof Error && (
        error.message === 'Invalid refresh token' ||
        error.message === 'Refresh token expired' ||
        error.message === 'User not found'
      )) {
        reply.status(401).send({ error: 'Invalid refresh token' });
        return;
      }
      throw error;
    }
  });

  // Logout (requires auth - handled by auth hook)
  app.post('/api/auth/logout', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }
    logout(userId);
    reply.send({ success: true });
  });

  // Get current user (requires auth)
  app.get('/api/auth/me', async (request, reply) => {
    const userId = request.userId;
    const username = request.username;
    if (!userId) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }
    reply.send({ id: userId, username });
  });
}
