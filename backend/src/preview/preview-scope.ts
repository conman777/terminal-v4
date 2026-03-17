import type { FastifyRequest } from 'fastify';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { isAllowedUsername, verifyAccessToken } from '../auth/auth-service.js';

export const PREVIEW_TOKEN_COOKIE = 'terminal_preview_token';

function getTokenFromQuery(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown> | undefined;
  const token = query?.token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function getTokenFromCookie(request: FastifyRequest): string | null {
  const rawCookie = request.headers.cookie;
  if (!rawCookie) return null;
  const cookies = parseCookie(rawCookie);
  const token = cookies[PREVIEW_TOKEN_COOKIE];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function getTokenFromAuthorizationHeader(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return token || null;
}

export function getPreviewAuthToken(request: FastifyRequest): string | null {
  return getTokenFromAuthorizationHeader(request)
    ?? getTokenFromQuery(request)
    ?? getTokenFromCookie(request);
}

export function resolvePreviewScopeId(request: FastifyRequest): string | null {
  if (typeof request.userId === 'string' && request.userId) {
    return request.userId;
  }

  const token = getPreviewAuthToken(request);
  if (!token) {
    return null;
  }

  const payload = verifyAccessToken(token);
  if (!payload || !isAllowedUsername(payload.username)) {
    return null;
  }

  return payload.sub;
}

export function getPreviewScopeIdOrAnonymous(request: FastifyRequest): string {
  return resolvePreviewScopeId(request) ?? 'anonymous';
}

export function getPreviewStoreKey(scopeId: string, port: number): string {
  return `${scopeId}:${port}`;
}

export function buildPreviewTokenCookie(token: string, secure = false): string {
  return serializeCookie(PREVIEW_TOKEN_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60
  });
}
