const DEFAULT_AI_CAPABILITIES = {
  prefersStructuredUi: false,
  supportsStructuredEvents: false,
  supportsPromptEvents: false
};

const KNOWN_AI_PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    title: 'Claude Code',
    launchCommand: 'claude',
    initialCommand: 'claude --dangerously-skip-permissions',
    color: '#ff6b2b',
    slashCommands: [
      { cmd: '/model', desc: 'Change AI model' },
      { cmd: '/clear', desc: 'Clear conversation' },
      { cmd: '/help', desc: 'Show available commands' },
      { cmd: '/compact', desc: 'Toggle compact mode' },
      { cmd: '/cost', desc: 'Show token usage' },
    ],
    capabilities: {
      prefersStructuredUi: false,
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
    slashCommands: [
      { cmd: '/model', desc: 'Change AI model' },
    ],
    capabilities: {
      prefersStructuredUi: false,
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
    slashCommands: [],
    capabilities: {
      prefersStructuredUi: false,
      supportsStructuredEvents: true,
      supportsPromptEvents: true
    }
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    title: 'Anthropic API',
    launchCommand: 'terminal-v4-api',
    initialCommand: 'terminal-v4-api',
    color: '#f97316',
    slashCommands: [],
    capabilities: { prefersStructuredUi: false, supportsStructuredEvents: false, supportsPromptEvents: false }
  },
  {
    id: 'xai',
    label: 'xAI / Grok',
    title: 'xAI / Grok',
    launchCommand: 'terminal-v4-api',
    initialCommand: 'terminal-v4-api',
    color: '#111827',
    slashCommands: [],
    capabilities: { prefersStructuredUi: false, supportsStructuredEvents: false, supportsPromptEvents: false }
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    title: 'GitHub Copilot',
    launchCommand: 'terminal-v4-api',
    initialCommand: 'terminal-v4-api',
    color: '#8b5cf6',
    slashCommands: [],
    capabilities: { prefersStructuredUi: false, supportsStructuredEvents: false, supportsPromptEvents: false }
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    title: 'DeepSeek',
    launchCommand: 'terminal-v4-api',
    initialCommand: 'terminal-v4-api',
    color: '#06b6d4',
    slashCommands: [],
    capabilities: { prefersStructuredUi: false, supportsStructuredEvents: false, supportsPromptEvents: false }
  },
  {
    id: 'moa',
    label: 'Mixture of Agents',
    title: 'Mixture of Agents',
    launchCommand: 'terminal-v4-api',
    initialCommand: 'terminal-v4-api',
    color: '#d6a84b',
    slashCommands: [],
    capabilities: { prefersStructuredUi: false, supportsStructuredEvents: false, supportsPromptEvents: false }
  },
];

const ADDITIONAL_AI_PROVIDERS = [
  ['openrouter', 'OpenRouter', '#f97316'],
  ['nous', 'Nous', '#14b8a6'],
  ['qwen-oauth', 'Qwen', '#0ea5e9'],
  ['minimax-oauth', 'MiniMax OAuth/API', '#f43f5e'],
  ['xai-oauth', 'xAI / Grok OAuth profile (API fallback)', '#0f172a'],
  ['openai-api', 'OpenAI API', '#10a37f'],
  ['actual', 'Actual Computer', '#f97316'],
  ['copilot-acp', 'GitHub Copilot ACP', '#7c3aed'],
  ['lmstudio', 'LM Studio', '#64748b'],
  ['tencent-tokenhub', 'Tencent TokenHub', '#ef4444'],
  ['zai', 'Zai / GLM', '#2563eb'],
  ['minimax', 'MiniMax', '#e11d48'],
  ['minimax-cn', 'MiniMax China', '#be123c'],
  ['kimi-coding', 'Kimi Coding', '#0f766e'],
  ['kimi-coding-cn', 'Kimi Coding China', '#115e59'],
  ['alibaba', 'Alibaba / DashScope', '#f59e0b'],
  ['alibaba-coding-plan', 'Alibaba Coding Plan', '#d97706'],
  ['xiaomi', 'Xiaomi MiMo', '#dc2626'],
  ['huggingface', 'Hugging Face', '#eab308'],
  ['fireworks', 'Fireworks AI', '#ef4444'],
  ['novita', 'Novita AI', '#8b5cf6'],
  ['nvidia', 'NVIDIA NIM', '#76b900'],
  ['deepinfra', 'DeepInfra', '#0891b2'],
  ['gmi', 'GMI Serving', '#4f46e5'],
  ['arcee', 'Arcee AI', '#9333ea'],
  ['stepfun', 'StepFun', '#16a34a'],
  ['upstage', 'Upstage Solar', '#ea580c'],
  ['kilocode', 'KiloCode', '#64748b'],
  ['ai-gateway', 'AI Gateway', '#0f172a'],
  ['opencode-zen', 'OpenCode Zen', '#475569'],
  ['opencode-go', 'OpenCode Go', '#334155'],
  ['ollama-cloud', 'Ollama Cloud', '#111827'],
  ['bedrock', 'AWS Bedrock', '#f59e0b'],
  ['vertex', 'Google Vertex AI', '#4285f4'],
  ['azure-foundry', 'Azure AI Foundry', '#0078d4'],
].map(([id, label, color]) => ({
  id,
  label,
  title: label,
  launchCommand: id === 'copilot-acp' ? 'copilot' : 'terminal-v4-api',
  initialCommand: id === 'copilot-acp' ? 'copilot' : 'terminal-v4-api',
  color,
  slashCommands: [],
  capabilities: { ...DEFAULT_AI_CAPABILITIES },
}));

KNOWN_AI_PROVIDERS.push(...ADDITIONAL_AI_PROVIDERS);

const KNOWN_PROVIDER_MAP = new Map(KNOWN_AI_PROVIDERS.map((provider) => [provider.id, provider]));
const AGENT_SLASH_ALIASES = new Map([
  ['gemni', 'gemini'],
]);
const AI_TYPE_ID_RE = /^[a-z][a-z0-9_-]*$/;
// Warm palette for user-defined AIs (cohesive with canonical theme tokens).
const CUSTOM_AI_COLORS = ['#d97706', '#fbbf24', '#e6875b', '#10b981', '#fb3654', '#92400e'];

function normalizeSlashCommands(slashCommands) {
  if (!Array.isArray(slashCommands)) return [];

  const seen = new Set();
  const normalized = [];

  for (const command of slashCommands) {
    const cmd = typeof command?.cmd === 'string' ? command.cmd.trim() : '';
    const desc = typeof command?.desc === 'string' ? command.desc.trim() : '';
    if (!cmd.startsWith('/') || !desc) continue;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    normalized.push({ cmd, desc });
  }

  return normalized;
}

function normalizeCustomProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return buildCustomAiProvider({
    id: provider.id,
    label: provider.label ?? provider.title,
    initialCommand: provider.initialCommand ?? provider.launchCommand,
    color: provider.color,
    slashCommands: provider.slashCommands,
    capabilities: provider.capabilities,
  });
}

function normalizeCustomProviders(customProviders = []) {
  if (!Array.isArray(customProviders)) return [];
  return customProviders
    .map(normalizeCustomProvider)
    .filter(Boolean);
}

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
    normalizeCustomProviders(customProviders)
      .map((provider) => [provider.id, provider])
  );
}

function createCustomOption(provider) {
  return {
    id: provider.id,
    label: provider.label,
    color: provider.color ?? '#e6875b'
  };
}

export function buildCustomAiProvider({ id, label, initialCommand, color, slashCommands, capabilities }) {
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
    color: color ?? '#e6875b',
    slashCommands: normalizeSlashCommands(slashCommands),
    capabilities: {
      ...DEFAULT_AI_CAPABILITIES,
      ...(capabilities && typeof capabilities === 'object' ? capabilities : {})
    }
  };
}

export function createCustomAiProvider(label, initialCommand, existingProviders = [], options = {}) {
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
    color,
    slashCommands: options?.slashCommands,
    capabilities: options?.capabilities,
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
    color: '#e6875b',
    slashCommands: [],
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

const AGENT_REASONING_LEVELS = {
  codex: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
};

function quoteAgentArgument(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    throw new Error(`Invalid agent ${label}`);
  }
  return `'${normalized.replaceAll("'", "'\\''")}'`;
}

const API_AGENT_IDS = new Set([
  'anthropic-api', 'xai', 'xai-oauth', 'openai-api', 'actual', 'copilot', 'deepseek', 'moa', 'openrouter', 'nous',
  'qwen-oauth', 'minimax-oauth', 'zai', 'minimax', 'minimax-cn', 'kimi-coding',
  'kimi-coding-cn', 'alibaba', 'alibaba-coding-plan', 'xiaomi', 'huggingface',
  'fireworks', 'novita', 'nvidia', 'deepinfra', 'gmi', 'arcee', 'stepfun',
  'upstage', 'kilocode', 'ai-gateway', 'opencode-zen', 'opencode-go',
  'ollama-cloud', 'lmstudio', 'tencent-tokenhub', 'bedrock', 'vertex', 'azure-foundry',
]);
const NATIVE_AGENT_COMMANDS = { codex: 'codex', claude: 'claude', gemini: 'gemini', 'copilot-acp': 'copilot' };

export function buildAgentLaunchCommand({ agent, model, reasoning = '', launchCommand = '' }) {
  const normalizedAgent = normalizeAiType(agent);
  if (normalizedAgent === 'copilot-acp') return NATIVE_AGENT_COMMANDS['copilot-acp'];
  if (API_AGENT_IDS.has(normalizedAgent)) {
    const runner = typeof launchCommand === 'string' && /^[a-zA-Z0-9_./ -]+$/.test(launchCommand.trim())
      ? launchCommand.trim()
      : 'node backend/dist/api-agent-runner.js';
    const parts = [runner, '--provider', quoteAgentArgument(normalizedAgent, 'provider'), '--model', quoteAgentArgument(model, 'model')];
    if (reasoning && normalizedAgent !== 'copilot') parts.push('--reasoning', quoteAgentArgument(reasoning, 'reasoning level'));
    return parts.join(' ');
  }
  const nativeCommand = NATIVE_AGENT_COMMANDS[normalizedAgent];
  if (!nativeCommand) throw new Error('Invalid native agent');
  const parts = [nativeCommand, '--model', quoteAgentArgument(model, 'model')];
  const normalizedReasoning = typeof reasoning === 'string' ? reasoning.trim().toLowerCase() : '';
  if (normalizedReasoning) {
    if (!AGENT_REASONING_LEVELS[normalizedAgent]?.has(normalizedReasoning)) {
      throw new Error('Invalid agent reasoning level');
    }
    if (normalizedAgent === 'codex') {
      parts.push('--config', quoteAgentArgument(`model_reasoning_effort=\"${normalizedReasoning}\"`, 'reasoning level'));
    } else if (normalizedAgent === 'claude') {
      parts.push('--effort', quoteAgentArgument(normalizedReasoning, 'reasoning level'));
    }
  }
  return parts.join(' ');
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

export function getAiComposerSlashCommands(aiType, customProviders = []) {
  return getAiProvider(aiType, customProviders)?.slashCommands ?? [];
}

export function shouldCreateStructuredSession(aiType, customProviders = []) {
  return getAiCapabilities(aiType, customProviders).prefersStructuredUi;
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
    || inferAiTypeFromText(session.thread?.aiType)
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
    ...normalizeCustomProviders(customProviders).map(createCustomOption)
  ];
}

export const AI_TYPE_OPTIONS = getAiTypeOptions();

export function getNewTabAiOptions(customProviders = []) {
  return [
    ...NEW_TAB_AI_OPTIONS,
    ...normalizeCustomProviders(customProviders).map((provider) => ({
      id: provider.id,
      label: provider.title ?? provider.label,
      title: provider.title ?? provider.label,
      command: provider.initialCommand
    }))
  ];
}

export const DEFAULT_CUSTOM_AI_PROVIDERS = [];
