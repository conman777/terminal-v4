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
  {
    id: 'aider',
    label: 'Aider',
    title: 'Aider',
    launchCommand: 'aider',
    initialCommand: 'aider',
    color: '#f97316'
  },
  {
    id: 'qwen',
    label: 'Qwen',
    title: 'Qwen CLI',
    launchCommand: 'qwen',
    initialCommand: 'qwen',
    color: '#14b8a6'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    title: 'Ollama',
    launchCommand: 'ollama',
    initialCommand: 'ollama',
    color: '#a78bfa'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    title: 'OpenCode',
    launchCommand: 'opencode',
    initialCommand: 'opencode',
    color: '#ec4899'
  }
];

const KNOWN_PROVIDER_MAP = new Map(KNOWN_AI_PROVIDERS.map((provider) => [provider.id, provider]));
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

export function getAiCapabilities(aiType) {
  const capabilities = getAiProvider(aiType)?.capabilities;
  return {
    ...DEFAULT_AI_CAPABILITIES,
    ...(capabilities && typeof capabilities === 'object' ? capabilities : {})
  };
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
