import type { FastifyInstance } from 'fastify';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadApiProviderStates } from '../agent/provider-runtime';

export interface AgentModelOption {
  id: string;
  label: string;
  default?: boolean;
}

export interface AgentCatalogEntry {
  id: string;
  label: string;
  command: string;
  launchCommand?: string;
  available: boolean;
  authenticated: boolean | null;
  status: 'ready' | 'auth-required' | 'not-installed' | 'not-configured';
  models: AgentModelOption[];
  reasoningLevels?: string[];
}

export interface AgentCatalog {
  defaultAgent: 'codex';
  agents: AgentCatalogEntry[];
}

export interface AgentCatalogRouteDependencies {
  loadCatalog?: (refresh: boolean, userId?: string) => Promise<AgentCatalog>;
}

const CODEX_FALLBACK_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
];
const CLAUDE_MODELS: Array<[string, string]> = [
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];
const GEMINI_MODELS: Array<[string, string]> = [
  ['auto', 'Auto'],
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
  ['gemini-3-flash-preview', 'Gemini 3 Flash Preview'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
];
const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

async function commandAvailable(command: string): Promise<boolean> {
  const result = await execa('which', [command], { timeout: 5_000, reject: false });
  return result.exitCode === 0 && Boolean(result.stdout.trim());
}

async function codexState(): Promise<{ available: boolean; authenticated: boolean | null }> {
  const available = await commandAvailable('codex');
  if (!available) return { available: false, authenticated: false };
  const result = await execa('codex', ['login', 'status'], { timeout: 15_000, reject: false });
  return { available, authenticated: result.exitCode === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`) };
}

async function claudeState(): Promise<{ available: boolean; authenticated: boolean | null }> {
  const available = await commandAvailable('claude');
  if (!available) return { available: false, authenticated: false };
  const result = await execa('claude', ['auth', 'status'], { timeout: 15_000, reject: false });
  try {
    const payload = JSON.parse(result.stdout);
    return { available, authenticated: payload.loggedIn === true };
  } catch {
    return { available, authenticated: result.exitCode === 0 ? null : false };
  }
}

async function geminiState(): Promise<{ available: boolean; authenticated: boolean | null }> {
  const available = await commandAvailable('gemini');
  if (!available) return { available: false, authenticated: false };
  const candidates = [
    join(homedir(), '.gemini', 'oauth_creds.json'),
    join(homedir(), '.gemini', 'settings.json'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { available, authenticated: true };
    } catch {
      // Check the next local Gemini configuration marker.
    }
  }
  return { available, authenticated: null };
}

async function codexModels(): Promise<{ models: AgentModelOption[]; current: string | null }> {
  const cachePath = join(homedir(), '.codex', 'models_cache.json');
  const configPath = join(homedir(), '.codex', 'config.toml');
  let models = CODEX_FALLBACK_MODELS;
  let current: string | null = null;
  try {
    const payload = JSON.parse(await readFile(cachePath, 'utf8')) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    const cached = (payload.models || [])
      .filter(model => model.visibility !== 'hide' && typeof model.slug === 'string')
      .map(model => ({ id: model.slug as string, label: model.display_name || model.slug as string }));
    if (cached.length > 0) models = cached.map(model => model.id);
  } catch {
    // Use stable native Codex fallbacks when the cache is unavailable.
  }
  try {
    const config = await readFile(configPath, 'utf8');
    current = config.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  } catch {
    // No local Codex config is valid; the first visible model becomes the default.
  }
  const visible = models.map(model => ({ id: model, label: model.replace(/^gpt-/, 'GPT-') }));
  const defaultId = current && visible.some(model => model.id === current) ? current : visible[0]?.id;
  return { models: visible.map(model => ({ ...model, default: model.id === defaultId })), current };
}

function statusFor(available: boolean, authenticated: boolean | null): AgentCatalogEntry['status'] {
  if (!available) return 'not-installed';
  if (authenticated === false) return 'auth-required';
  return 'ready';
}

export async function loadAgentCatalog(_refresh = false, userId?: string): Promise<AgentCatalog> {
  const [codex, claude, gemini, codexModelsResult, apiStates] = await Promise.all([
    codexState(),
    claudeState(),
    geminiState(),
    codexModels(),
    loadApiProviderStates(userId),
  ]);
  const models = (values: Array<[string, string]>): AgentModelOption[] => values.map(([id, label], index) => ({ id, label, default: index === 0 }));
  return {
    defaultAgent: 'codex',
    agents: [
      {
        id: 'codex', label: 'Codex', command: 'codex', ...codex,
        status: statusFor(codex.available, codex.authenticated), models: codexModelsResult.models,
        reasoningLevels: REASONING_LEVELS,
      },
      {
        id: 'claude', label: 'Claude Code', command: 'claude', ...claude,
        status: statusFor(claude.available, claude.authenticated), models: models(CLAUDE_MODELS),
        reasoningLevels: REASONING_LEVELS,
      },
      {
        id: 'gemini', label: 'Gemini CLI', command: 'gemini', ...gemini,
        status: statusFor(gemini.available, gemini.authenticated), models: models(GEMINI_MODELS),
      },
      ...apiStates.map(state => ({
        id: state.definition.id,
        label: state.definition.label,
        command: state.definition.command || 'terminal-v4-api',
        launchCommand: state.definition.transport === 'external-cli'
          ? state.definition.command
          : `node ${join(process.cwd(), 'dist/agent/api-agent-runner.js')}${userId && /^[a-zA-Z0-9_-]+$/.test(userId) ? ` --user-id ${userId}` : ''}`,
        available: true,
        authenticated: state.authenticated,
        status: state.status,
        models: state.definition.models,
        reasoningLevels: state.definition.reasoningLevels,
      })),
    ],
  };
}

export async function registerAgentCatalogRoutes(
  app: FastifyInstance,
  dependencies: AgentCatalogRouteDependencies = {},
): Promise<void> {
  const loadCatalog = dependencies.loadCatalog ?? loadAgentCatalog;
  app.get('/api/agent/catalog', async (request, reply) => {
    if (!request.userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const catalog = await loadCatalog(String((request.query as Record<string, unknown> | undefined)?.refresh || '') === 'true', request.userId);
      reply.header('Cache-Control', 'private, max-age=60').send(catalog);
    } catch (error) {
      request.log.warn({ err: error }, 'Failed to load native agent catalog');
      reply.code(503).send({ error: error instanceof Error ? error.message : 'Failed to load native agent catalog' });
    }
  });
}
