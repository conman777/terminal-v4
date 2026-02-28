import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, isAllowedUsername } from './auth-service.js';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/health',
  '/api/auth/passkey/authenticate/begin',
  '/api/auth/passkey/authenticate/complete'
];

// Route patterns that don't require authentication (for dynamic routes)
const PUBLIC_ROUTE_PATTERNS = [
  /^\/api\/browser\//            // Browser automation API
];

// Extend Fastify request type
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    username?: string;
  }

  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

// Match preview subdomain pattern (preview-{port}.*)
const PREVIEW_SUBDOMAIN_REGEX = /^preview-\d+\./i;

export function registerAuthHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for preview subdomain requests (they're proxied to other apps)
    const host = request.headers.host || '';
    if (PREVIEW_SUBDOMAIN_REGEX.test(host)) {
      return;
    }

    // Respect route-level auth overrides.
    const routeConfig = request.routeOptions?.config as { skipAuth?: boolean } | undefined;
    if (routeConfig?.skipAuth) {
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
