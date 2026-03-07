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

export function getAiProvider(aiType) {
  const normalized = normalizeAiType(aiType);
  if (!normalized || normalized === 'cli') return null;

  const knownProvider = KNOWN_PROVIDER_MAP.get(normalized);
  if (knownProvider) return knownProvider;

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

export function getAiDisplayLabel(aiType) {
  return getAiProvider(aiType)?.label ?? null;
}

export function getAiLaunchCommand(aiType) {
  return getAiProvider(aiType)?.launchCommand ?? '';
}

export function getAiInitialCommand(aiType) {
  return getAiProvider(aiType)?.initialCommand ?? '';
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

export function getAiCapabilities(aiType) {
  const capabilities = getAiProvider(aiType)?.capabilities;
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

export const AI_TYPE_OPTIONS = [
  { id: null, label: 'CLI (default)', color: '#f59e0b' },
  ...KNOWN_AI_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    color: provider.color
  }))
];
