import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prepare = vi.fn();
vi.mock('../database/db', () => ({ getDatabase: () => ({ prepare }) }));
vi.mock('../utils/secret-crypto', () => ({ encryptSecret: (value: string) => `enc:v1:${Buffer.from(value).toString('base64')}` }));
vi.mock('../agent/provider-runtime', () => ({
  API_PROVIDER_DEFINITIONS: [
    { id: 'anthropic-api', label: 'Anthropic API', auth: 'api-key', authMethods: ['api-key', 'oauth'], oauthCommand: 'claude auth login --console', oauthHelp: 'Claude opens the Anthropic Console OAuth flow with API usage billing.', models: [{ id: 'claude-sonnet-5' }] },
    { id: 'deepseek', label: 'DeepSeek', auth: 'api-key', models: [{ id: 'deepseek-v4-pro' }] },
    { id: 'copilot', label: 'GitHub Copilot', auth: 'oauth', models: [{ id: 'gpt-4o' }] },
  ],
  loadApiProviderStates: vi.fn().mockResolvedValue([
    { definition: { id: 'anthropic-api', label: 'Anthropic API', auth: 'api-key', authMethods: ['api-key', 'oauth'], oauthCommand: 'claude auth login --console', models: [{ id: 'claude-sonnet-5' }] }, status: 'auth-required', authenticated: false },
    { definition: { id: 'deepseek', label: 'DeepSeek', auth: 'api-key', models: [{ id: 'deepseek-v4-pro' }] }, status: 'auth-required', authenticated: false },
    { definition: { id: 'copilot', label: 'GitHub Copilot', auth: 'oauth', models: [{ id: 'gpt-4o' }] }, status: 'auth-required', authenticated: false },
  ]),
  resolveProviderCredential: vi.fn().mockResolvedValue(null),
}));

import { registerAgentAuthRoutes } from './agent-auth-routes';

describe('agent authentication routes', () => {
  beforeEach(() => prepare.mockReset());

  it('returns auth methods and status without returning credential values', async () => {
    const app = Fastify();
    app.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentAuthRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/agent/auth' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: 'codex', methods: ['oauth'], command: 'codex login' }),
        expect.objectContaining({ id: 'anthropic-api', methods: ['api-key', 'oauth'], command: 'claude auth login --console' }),
        expect.objectContaining({ id: 'copilot', methods: ['oauth'], command: 'gh auth login --web' }),
        expect.objectContaining({ id: 'deepseek', configured: false, masked: null }),
      ]),
    }));
    expect(JSON.stringify(response.json())).not.toContain('secret-value');
    await app.close();
  });

  it('rejects unauthenticated API-key writes and invalid key lengths', async () => {
    const app = Fastify();
    await registerAgentAuthRoutes(app);
    expect((await app.inject({ method: 'PUT', url: '/api/agent/auth/deepseek/api-key', payload: { apiKey: 'secret-value' } })).statusCode).toBe(401);
    await app.close();

    const authenticated = Fastify();
    authenticated.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentAuthRoutes(authenticated);
    const response = await authenticated.inject({ method: 'PUT', url: '/api/agent/auth/deepseek/api-key', payload: { apiKey: 'short' } });
    expect(response.statusCode).toBe(400);
    await authenticated.close();
  });

  it('rejects API-key writes for the OAuth-only Copilot provider', async () => {
    const app = Fastify();
    app.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentAuthRoutes(app);
    const response = await app.inject({ method: 'PUT', url: '/api/agent/auth/copilot/api-key', payload: { apiKey: 'copilot-token-value' } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('stores only encrypted provider values under a namespaced vault key', async () => {
  let lastRun: { sql: string; args: unknown[] } | null = null;
  prepare.mockImplementation((sql: string) => ({
      get: () => undefined,
      run: (...args: unknown[]) => { lastRun = { sql, args }; return { changes: 1 }; },
    }));
    const app = Fastify();
    app.addHook('preHandler', async request => { request.userId = 'user-1'; });
    await registerAgentAuthRoutes(app);
    const response = await app.inject({ method: 'PUT', url: '/api/agent/auth/deepseek/api-key', payload: { apiKey: 'deepseek-secret-value' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider: 'deepseek', configured: true, masked: '****alue' });
    const storedArgs = (lastRun as { args: unknown[] } | null)?.args || [];
    expect(String(storedArgs[3] || '')).not.toContain('deepseek-secret-value');
    expect(storedArgs[3]).toBe('enc:v1:ZGVlcHNlZWstc2VjcmV0LXZhbHVl');
    await app.close();
  });
});
