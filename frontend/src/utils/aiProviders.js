const KNOWN_AI_PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    title: 'Claude Code',
    launchCommand: 'claude',
    initialCommand: 'claude --dangerously-skip-permissions',
    color: '#ff6b2b',
    capabilities: {
      prefersStructuredUi: true,
      supportsStructuredEvents: true,
      supportsPromptEvents: true
    }
  },
  {
    id: 'codex',
    label: 'Codex',
    title: 'Codex',
    launchCommand: 'codex',
    initialCommand: 'codex --yolo',
    color: '#3b82f6',
    capabilities: {
      prefersStructuredUi: true,
      supportsStructuredEvents: true,
      supportsPromptEvents: true
    }
  },
  {
    id: 'gemini',
    label: 'Gemini',
    title: 'Gemini CLI',
    launchCommand: 'gemini',
    initialCommand: 'gemini --yolo',
    color: '#22c55e',
    capabilities: {
      prefersStructuredUi: true,
      supportsStructuredEvents: true,
      supportsPromptEvents: true
    }
  },
];

const KNOWN_PROVIDER_MAP = new Map(KNOWN_AI_PROVIDERS.map((provider) => [provider.id, provider]));
const AGENT_SLASH_ALIASES = new Map([
  ['gemni', 'gemini'],
]);
const AI_TYPE_ID_RE = /^[a-z][a-z0-9_-]*$/;
const CUSTOM_AI_COLORS = ['#f97316', '#06b6d4', '#84cc16', '#e879f9', '#f43f5e', '#a78bfa'];
const DEFAULT_AI_CAPABILITIES = {
  prefersStructuredUi: false,
  supportsStructuredEvents: false,
  supportsPromptEvents: false
};

function humanizeAiType(aiType) {
  return aiType
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (part.toLowerCase() === 'ai') return 'AI';
      if (part.toLowerCase() === 'cli') return 'CLI';
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(' ');
}

export function normalizeAiType(aiType) {
  if (typeof aiType !== 'string') return null;
  const normalized = aiType.trim().toLowerCase();
  if (!normalized || !AI_TYPE_ID_RE.test(normalized)) return null;
  return normalized;
}

function createCustomProviderMap(customProviders = []) {
  return new Map(
    (Array.isArray(customProviders) ? customProviders : [])
      .filter((provider) => provider?.id)
      .map((provider) => [provider.id, provider])
  );
}

function createCustomOption(provider) {
  return {
    id: provider.id,
    label: provider.label,
    color: provider.color ?? '#38bdf8'
  };
}

export function buildCustomAiProvider({ id, label, initialCommand, color }) {
  const normalizedId = normalizeAiType(id);
  const trimmedLabel = typeof label === 'string' ? label.trim() : '';
  const trimmedCommand = typeof initialCommand === 'string' ? initialCommand.trim() : '';
  if (!normalizedId || !trimmedLabel || !trimmedCommand) return null;

  const launchCommand = trimmedCommand.split(/\s+/)[0] || trimmedCommand;
  return {
    id: normalizedId,
    label: trimmedLabel,
    title: trimmedLabel,
    launchCommand,
    initialCommand: trimmedCommand,
    color: color ?? '#38bdf8',
    capabilities: { ...DEFAULT_AI_CAPABILITIES }
  };
}

export function createCustomAiProvider(label, initialCommand, existingProviders = []) {
  const trimmedLabel = typeof label === 'string' ? label.trim() : '';
  const trimmedCommand = typeof initialCommand === 'string' ? initialCommand.trim() : '';
  if (!trimmedLabel || !trimmedCommand) return null;

  const baseId = trimmedLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'custom-ai';

  const existingIds = new Set([
    ...KNOWN_AI_PROVIDERS.map((provider) => provider.id),
    ...(Array.isArray(existingProviders) ? existingProviders.map((provider) => provider?.id).filter(Boolean) : [])
  ]);

  let nextId = baseId;
  let suffix = 2;
  while (existingIds.has(nextId)) {
    nextId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const color = CUSTOM_AI_COLORS[existingIds.size % CUSTOM_AI_COLORS.length];
  return buildCustomAiProvider({
    id: nextId,
    label: trimmedLabel,
    initialCommand: trimmedCommand,
    color
  });
}

export function getAiProvider(aiType, customProviders = []) {
  const normalized = normalizeAiType(aiType);
  if (!normalized || normalized === 'cli') return null;

  const knownProvider = KNOWN_PROVIDER_MAP.get(normalized);
  if (knownProvider) return knownProvider;

  const customProvider = createCustomProviderMap(customProviders).get(normalized);
  if (customProvider) return customProvider;

  const label = humanizeAiType(normalized);
  return {
    id: normalized,
    label,
    title: label,
    launchCommand: normalized,
    initialCommand: normalized,
    color: '#38bdf8',
    capabilities: { ...DEFAULT_AI_CAPABILITIES }
  };
}

export function getAiDisplayLabel(aiType, customProviders = []) {
  return getAiProvider(aiType, customProviders)?.label ?? null;
}

export function getAiLaunchCommand(aiType, customProviders = []) {
  return getAiProvider(aiType, customProviders)?.launchCommand ?? '';
}

export function getAiInitialCommand(aiType, customProviders = []) {
  return getAiProvider(aiType, customProviders)?.initialCommand ?? '';
}

export function resolveSlashAgentCommand(text) {
  if (typeof text !== 'string') return null;

  const normalized = text.trim();
  if (!normalized.startsWith('/')) return null;

  const match = normalized.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
  if (!match) return null;

  const requestedAgent = match[1].toLowerCase();
  const providerId = AGENT_SLASH_ALIASES.get(requestedAgent) ?? requestedAgent;
  const provider = KNOWN_PROVIDER_MAP.get(providerId);
  if (!provider) return null;

  const args = match[2]?.trim();
  if (!args) {
    return provider.initialCommand;
  }

  return `${provider.launchCommand} ${args}`;
}

export function rewriteTerminalAgentInput(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (text.includes('\x1b')) return text;

  const newlineMatch = text.match(/(\r\n|\r|\n)$/);
  const newline = newlineMatch?.[1] ?? '';
  const body = newline ? text.slice(0, -newline.length) : text;
  const resolved = resolveSlashAgentCommand(body);
  if (!resolved) return text;
  return `${resolved}${newline}`;
}

export function getAiCapabilities(aiType, customProviders = []) {
  const capabilities = getAiProvider(aiType, customProviders)?.capabilities;
  return {
    ...DEFAULT_AI_CAPABILITIES,
    ...(capabilities && typeof capabilities === 'object' ? capabilities : {})
  };
}

function inferAiTypeFromText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  for (const provider of KNOWN_AI_PROVIDERS) {
    const tokens = [
      provider.id,
      provider.label,
      provider.title,
      provider.launchCommand
    ].map((token) => String(token).trim().toLowerCase());

    if (tokens.some((token) => token && normalized.includes(token))) {
      return provider.id;
    }
  }

  return null;
}

export function inferSessionAiType(session, explicitAiType = null) {
  const explicit = normalizeAiType(explicitAiType);
  if (explicit) return explicit;
  if (!session || typeof session !== 'object') return null;

  return (
    inferAiTypeFromText(session.aiType)
    || inferAiTypeFromText(session.shell)
    || inferAiTypeFromText(session.title)
    || inferAiTypeFromText(session.thread?.topic)
    || null
  );
}

export const COMMON_LAUNCH_PREFIXES = KNOWN_AI_PROVIDERS.map((provider) => provider.launchCommand);

export const NEW_TAB_AI_OPTIONS = [
  { id: 'cli', label: 'CLI' },
  ...KNOWN_AI_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.title,
    title: provider.title,
    command: provider.initialCommand
  }))
];

export function getAiTypeOptions(customProviders = []) {
  return [
    { id: null, label: 'CLI (default)', color: '#f59e0b' },
    ...KNOWN_AI_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      color: provider.color
    })),
    ...(Array.isArray(customProviders) ? customProviders.map(createCustomOption) : [])
  ];
}

export const AI_TYPE_OPTIONS = getAiTypeOptions();

export function getNewTabAiOptions(customProviders = []) {
  return [
    ...NEW_TAB_AI_OPTIONS,
    ...(Array.isArray(customProviders) ? customProviders.map((provider) => ({
      id: provider.id,
      label: provider.title ?? provider.label,
      title: provider.title ?? provider.label,
      command: provider.initialCommand
    })) : [])
  ];
}

export const DEFAULT_CUSTOM_AI_PROVIDERS = [];
