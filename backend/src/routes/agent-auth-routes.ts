import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../database/db';
import { encryptSecret } from '../utils/secret-crypto';
import { API_PROVIDER_DEFINITIONS, loadApiProviderStates, resolveProviderCredential } from '../agent/provider-runtime';

interface ProviderParams { provider: string }
interface ApiKeyBody { apiKey: string }

const NATIVE_AUTH = [
  { id: 'codex', label: 'Codex', methods: ['oauth'], command: 'codex login', help: 'Codex opens its browser sign-in flow.' },
  { id: 'claude', label: 'Claude Code', methods: ['oauth'], command: 'claude auth login', help: 'Claude Code opens its authentication flow.' },
  { id: 'gemini', label: 'Gemini CLI', methods: ['oauth'], command: 'gemini', help: 'Gemini CLI prompts for Google authentication when needed.' },
];

function keyName(provider: string): string { return `terminal-v4:provider:${provider}`; }
function mask(value: string): string { return value.length <= 4 ? '****' : `****${value.slice(-4)}`; }
function providerMethods(definition: (typeof API_PROVIDER_DEFINITIONS)[number]): string[] {
  return definition.authMethods || [definition.auth];
}

function isKnownApiProvider(provider: string): boolean {
  return API_PROVIDER_DEFINITIONS.some(definition => definition.id === provider && providerMethods(definition).includes('api-key') && definition.auth !== 'virtual');
}

function requireUser(request: { userId?: string }, reply: { code: (status: number) => { send: (body: unknown) => void } }): string | null {
  if (!request.userId) { reply.code(401).send({ error: 'Unauthorized' }); return null; }
  return request.userId;
}

export async function registerAgentAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/auth', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;
    const apiStates = await loadApiProviderStates(userId);
    const apiProviders = await Promise.all(apiStates.map(async state => {
      const credential = await resolveProviderCredential(state.definition, process.env, userId);
      const methods = providerMethods(state.definition);
      const oauth = methods.includes('oauth');
      const commandAuth = oauth || methods.includes('cli');
      const credentialConfigured = Boolean(credential);
      return {
        id: state.definition.id,
        label: state.definition.label,
        methods,
        ...(commandAuth ? {
          command: state.definition.oauthCommand || state.definition.command || (oauth ? 'gh auth login --web' : undefined),
          help: state.definition.oauthHelp || state.definition.commandHelp || (oauth ? 'Open the provider browser OAuth login flow.' : 'Use the provider native authentication setup.'),
        } : {}),
        status: state.status,
        configured: state.authenticated || credentialConfigured,
        masked: credential ? mask(credential) : null,
        models: state.definition.models.length,
      };
    }));
    return { providers: [...NATIVE_AUTH, ...apiProviders] };
  });

  app.put<{ Params: ProviderParams; Body: ApiKeyBody }>('/api/agent/auth/:provider/api-key', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;
    const provider = request.params.provider;
    const apiKey = request.body?.apiKey;
    if (!isKnownApiProvider(provider)) { reply.code(404).send({ error: 'Provider does not accept API keys' }); return; }
    if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 10000) {
      reply.code(400).send({ error: 'API key must be 8-10000 characters' }); return;
    }
    const db = getDatabase();
    const name = keyName(provider);
    const encrypted = encryptSecret(apiKey.trim());
    const existing = db.prepare('SELECT id FROM api_key_vault WHERE user_id = ? AND key_name = ?').get(userId, name) as { id?: string } | undefined;
    if (existing?.id) {
      db.prepare('UPDATE api_key_vault SET key_value = ? WHERE id = ? AND user_id = ?').run(encrypted, existing.id, userId);
    } else {
      db.prepare('INSERT INTO api_key_vault (id, user_id, key_name, key_value, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), userId, name, encrypted, new Date().toISOString());
    }
    return { provider, configured: true, masked: mask(apiKey.trim()) };
  });

  app.delete<{ Params: ProviderParams }>('/api/agent/auth/:provider/api-key', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;
    const provider = request.params.provider;
    if (!isKnownApiProvider(provider)) { reply.code(404).send({ error: 'Provider does not accept API keys' }); return; }
    getDatabase().prepare('DELETE FROM api_key_vault WHERE user_id = ? AND key_name = ?').run(userId, keyName(provider));
    reply.code(204).send();
  });
}
