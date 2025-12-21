import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from './auth-service.js';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/health'
];

// Extend Fastify request type
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    username?: string;
  }
}

export function registerAuthHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public routes
    if (PUBLIC_ROUTES.some(route => request.url.startsWith(route))) {
      return;
    }

    // Skip auth for non-API routes (like health checks, static files)
    if (!request.url.startsWith('/api/')) {
      return;
    }

    // Get token from Authorization header or query parameter (for SSE/EventSource)
    let token: string | null = null;

    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7); // Remove 'Bearer ' prefix
    }

    // Fall back to query parameter for SSE endpoints (EventSource doesn't support headers)
    if (!token) {
      const query = request.query as Record<string, string>;
      if (query.token) {
        token = query.token;
      }
    }

    if (!token) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    const payload = verifyAccessToken(token);

    if (!payload) {
      reply.status(401).send({ error: 'Invalid or expired token' });
      return;
    }

    // Attach user info to request
    request.userId = payload.sub;
    request.username = payload.username;
  });
}
