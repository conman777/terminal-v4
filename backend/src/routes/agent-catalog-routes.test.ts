import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentCatalogRoutes } from './agent-catalog-routes';

describe('native agent catalog route', () => {
  it('returns Terminal v4 native agents and models for an authenticated user', async () => {
    const catalog = {
      defaultAgent: 'codex' as const,
      agents: [{
        id: 'codex' as const,
        label: 'Codex',
        command: 'codex',
        available: true,
        authenticated: true,
        status: 'ready' as const,
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', default: true }],
        reasoningLevels: ['low', 'high'],
      }],
    };
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    const app = Fastify();
    app.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentCatalogRoutes(app, { loadCatalog });

    const response = await app.inject({ method: 'GET', url: '/api/agent/catalog' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(catalog);
    expect(loadCatalog).toHaveBeenCalledWith(false, 'user-1');
    await app.close();
  });

  it('supports refresh and rejects unauthenticated requests', async () => {
    const loadCatalog = vi.fn().mockResolvedValue({ defaultAgent: 'codex', agents: [] });
    const app = Fastify();
    await registerAgentCatalogRoutes(app, { loadCatalog });

    const response = await app.inject({ method: 'GET', url: '/api/agent/catalog?refresh=true' });

    expect(response.statusCode).toBe(401);
    expect(loadCatalog).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns auth-required and not-installed states instead of hiding agents', async () => {
    const loadCatalog = vi.fn().mockResolvedValue({
      defaultAgent: 'codex',
      agents: [
        { id: 'codex', label: 'Codex', command: 'codex', available: true, authenticated: false, status: 'auth-required', models: [] },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: false, authenticated: false, status: 'not-installed', models: [] },
      ],
    });
    const app = Fastify();
    app.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentCatalogRoutes(app, { loadCatalog });

    const response = await app.inject({ method: 'GET', url: '/api/agent/catalog' });

    expect(response.json().agents.map((agent: { status: string }) => agent.status)).toEqual(['auth-required', 'not-installed']);
    await app.close();
  });
});
