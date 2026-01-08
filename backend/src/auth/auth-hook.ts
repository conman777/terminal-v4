import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, isAllowedUsername } from './auth-service.js';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/health'
];

// Route patterns that don't require authentication (for dynamic routes)
const PUBLIC_ROUTE_PATTERNS = [
  /^\/api\/preview\/\d+\/logs$/, // Preview logs per port (client-side)
  /^\/api\/preview\/logs$/,      // List all preview logs
  /^\/api\/preview\/external\/logs$/, // External preview logs
  /^\/api\/preview\/\d+\/process-logs$/, // Server-side process logs per port
  /^\/api\/process-logs(\/\d+)?$/, // Process logs by PID or list all
  /^\/api\/browser\//            // Browser automation API
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
    // Skip auth for preview subdomains (they have their own auth)
    const host = request.headers.host || '';
    if (host.startsWith('preview-')) {
      return;
    }

    // Skip auth for public routes
    if (PUBLIC_ROUTES.some(route => request.url.startsWith(route))) {
      return;
    }

    // Skip auth for public route patterns (preview logs endpoints)
    const urlPath = request.url.split('?')[0]; // Remove query string
    if (PUBLIC_ROUTE_PATTERNS.some(pattern => pattern.test(urlPath))) {
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
    if (!isAllowedUsername(payload.username)) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    // Attach user info to request
    request.userId = payload.sub;
    request.username = payload.username;
  });
}
