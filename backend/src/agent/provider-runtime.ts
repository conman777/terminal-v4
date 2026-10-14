import { getDatabase } from '../database/db';
import { decryptSecret } from '../utils/secret-crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ProviderTransport =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'bedrock-converse'
  | 'vertex-openai'
  | 'azure-openai'
  | 'external-cli'
  | 'virtual';
export type ProviderAuthKind = 'api-key' | 'oauth' | 'cloud' | 'cli' | 'virtual';
export type ProviderCredentialKind = 'api-key' | 'oauth';
export type ProviderRuntimeStatus = 'ready' | 'auth-required' | 'not-configured' | 'not-installed';

export interface ProviderModel {
  id: string;
  label: string;
  default?: boolean;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  transport: ProviderTransport;
  auth: ProviderAuthKind;
  authMethods?: ProviderAuthKind[];
  oauthCommand?: string;
  oauthHelp?: string;
  command?: string;
  commandHelp?: string;
  baseUrl: string;
  baseUrlEnvKey?: string;
  requiresBaseUrl?: boolean;
  allowLocalNoAuth?: boolean;
  envKeys: string[];
  models: ProviderModel[];
  reasoningLevels?: string[];
  projectEnvKey?: string;
  locationEnvKey?: string;
  deploymentEnvKey?: string;
}

export interface ProviderRuntimeState {
  definition: ProviderDefinition;
  status: ProviderRuntimeStatus;
  authenticated: boolean;
}

const reasoningLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = (entries: Array<[string, string]>, defaultId = entries[0]?.[0]): ProviderModel[] =>
  entries.map(([id, label]) => ({ id, label, default: id === defaultId }));

const openAiModels = (entries: Array<[string, string]>, defaultId?: string): ProviderModel[] => models(entries, defaultId);
const anthropicModels = (entries: Array<[string, string]>, defaultId?: string): ProviderModel[] => models(entries, defaultId);

export const API_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    transport: 'anthropic-messages',
    auth: 'api-key',
    authMethods: ['api-key', 'oauth'],
    oauthCommand: 'claude auth login --console',
    oauthHelp: 'Claude opens the Anthropic Console OAuth flow with API usage billing.',
    baseUrl: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
    models: anthropicModels([
      ['claude-fable-5', 'Claude Fable 5'],
      ['claude-sonnet-5', 'Claude Sonnet 5'],
      ['claude-opus-4-8', 'Claude Opus 4.8'],
      ['claude-opus-4-7', 'Claude Opus 4.7'],
      ['claude-opus-4-6', 'Claude Opus 4.6'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['claude-opus-4-5-20251101', 'Claude Opus 4.5'],
      ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
      ['claude-opus-4-20250514', 'Claude Opus 4'],
      ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
      ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
      ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
      ['claude-opus-5', 'Claude Opus 5'],
    ]),
    reasoningLevels,
  },
  {
    id: 'xai',
    label: 'xAI / Grok',
    transport: 'openai-responses',
    auth: 'api-key',
    baseUrl: 'https://api.x.ai/v1',
    baseUrlEnvKey: 'XAI_BASE_URL',
    envKeys: ['XAI_API_KEY'],
    models: openAiModels([
      ['grok-build-0.1', 'Grok Build 0.1'],
      ['grok-composer-2.5-fast', 'Grok Composer 2.5 Fast'],
      ['grok-4.20-0309-non-reasoning', 'Grok 4.20'],
      ['grok-4.20-0309-reasoning', 'Grok 4.20 Reasoning'],
      ['grok-4.20-multi-agent-0309', 'Grok 4.20 Multi-Agent'],
      ['grok-4.3', 'Grok 4.3'],
      ['grok-4.5', 'Grok 4.5'],
    ]),
    reasoningLevels,
  },
  {
    id: 'xai-oauth',
    label: 'xAI / Grok OAuth profile (API fallback)',
    transport: 'openai-responses',
    auth: 'api-key',
    authMethods: ['api-key'],
    baseUrl: 'https://api.x.ai/v1',
    baseUrlEnvKey: 'XAI_BASE_URL',
    envKeys: ['XAI_API_KEY'],
    models: openAiModels([
      ['grok-4.5', 'Grok 4.5'],
      ['grok-4.3', 'Grok 4.3'],
    ]),
    reasoningLevels,
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    transport: 'openai-responses',
    auth: 'api-key',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    envKeys: ['OPENAI_API_KEY'],
    models: openAiModels([
      ['gpt-5.4', 'GPT-5.4'],
      ['gpt-4.1', 'GPT-4.1'],
    ]),
    reasoningLevels,
  },
  {
    id: 'actual',
    label: 'Actual Computer',
    transport: 'openai-responses',
    auth: 'api-key',
    baseUrl: 'https://api.actual.inc/v1',
    baseUrlEnvKey: 'ACTUAL_BASE_URL',
    allowLocalNoAuth: true,
    envKeys: ['ACTUAL_API_KEY'],
    models: openAiModels([
      ['actual/test-model', 'Actual hosted model'],
      ['actual/local-model', 'Actual local model'],
    ]),
    reasoningLevels: ['none', 'low', 'medium', 'high', 'max'],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    transport: 'openai-chat',
    auth: 'oauth',
    baseUrl: 'https://api.githubcopilot.com',
    envKeys: [],
    models: openAiModels([
      ['gpt-4o', 'GPT-4o'],
      ['gpt-4.1', 'GPT-4.1'],
    ]),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.deepseek.com/v1',
    baseUrlEnvKey: 'DEEPSEEK_BASE_URL',
    envKeys: ['DEEPSEEK_API_KEY'],
    models: openAiModels([
      ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
      ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
    ]),
    reasoningLevels,
  },
  {
    id: 'moa',
    label: 'Mixture of Agents',
    transport: 'virtual',
    auth: 'virtual',
    baseUrl: '',
    envKeys: [],
    models: models([['default', 'Default ensemble']]),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnvKey: 'OPENROUTER_BASE_URL',
    envKeys: ['OPENROUTER_API_KEY'],
    models: openAiModels([
      ['openai/gpt-4o', 'OpenAI GPT-4o'],
      ['anthropic/claude-sonnet-4', 'Claude Sonnet'],
      ['google/gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ]),
    reasoningLevels,
  },
  {
    id: 'nous',
    label: 'Nous',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    baseUrlEnvKey: 'NOUS_BASE_URL',
    envKeys: ['NOUS_API_KEY'],
    models: openAiModels([
      ['Hermes-4-70B', 'Nous 4 70B'],
      ['Hermes-4-405B', 'Nous 4 405B'],
    ]),
    reasoningLevels,
  },
  {
    id: 'qwen-oauth',
    label: 'Qwen',
    transport: 'openai-chat',
    auth: 'api-key',
    authMethods: ['api-key'],
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvKey: 'QWEN_BASE_URL',
    envKeys: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    models: openAiModels([
      ['qwen3-coder-plus', 'Qwen3 Coder Plus'],
      ['qwen3.5-plus', 'Qwen3.5 Plus'],
    ]),
    reasoningLevels,
  },
  {
    id: 'minimax-oauth',
    label: 'MiniMax OAuth/API',
    transport: 'anthropic-messages',
    auth: 'api-key',
    baseUrl: 'https://api.minimax.io/anthropic',
    baseUrlEnvKey: 'MINIMAX_BASE_URL',
    envKeys: ['MINIMAX_API_KEY'],
    models: anthropicModels([
      ['MiniMax-M2.5', 'MiniMax M2.5'],
      ['MiniMax-M2.1', 'MiniMax M2.1'],
    ]),
    reasoningLevels,
  },
  {
    id: 'copilot-acp',
    label: 'GitHub Copilot ACP',
    transport: 'external-cli',
    auth: 'cli',
    command: 'copilot',
    commandHelp: 'Uses the installed GitHub Copilot CLI through the Terminal v4 PTY.',
    baseUrl: 'acp://copilot',
    envKeys: [],
    models: models([
      ['default', 'Copilot CLI default'],
    ]),
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'http://127.0.0.1:1234/v1',
    baseUrlEnvKey: 'LM_BASE_URL',
    allowLocalNoAuth: true,
    envKeys: ['LM_API_KEY'],
    models: openAiModels([
      ['local-model', 'LM Studio loaded model'],
    ]),
    reasoningLevels,
  },
  {
    id: 'tencent-tokenhub',
    label: 'Tencent TokenHub',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    baseUrlEnvKey: 'TOKENHUB_BASE_URL',
    requiresBaseUrl: true,
    envKeys: ['TOKENHUB_API_KEY'],
    models: openAiModels([
      ['default', 'TokenHub default model'],
    ]),
    reasoningLevels,
  },
  {
    id: 'zai',
    label: 'Zai / GLM',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    baseUrlEnvKey: 'GLM_BASE_URL',
    envKeys: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
    models: openAiModels([
      ['glm-5', 'GLM-5'],
      ['glm-4.5', 'GLM-4.5'],
      ['glm-4.5-air', 'GLM-4.5 Air'],
    ]),
    reasoningLevels,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    transport: 'anthropic-messages',
    auth: 'api-key',
    baseUrl: 'https://api.minimax.io/anthropic',
    baseUrlEnvKey: 'MINIMAX_BASE_URL',
    envKeys: ['MINIMAX_API_KEY'],
    models: anthropicModels([
      ['MiniMax-M2.5', 'MiniMax M2.5'],
      ['MiniMax-M2.1', 'MiniMax M2.1'],
    ]),
    reasoningLevels,
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax China',
    transport: 'anthropic-messages',
    auth: 'api-key',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    baseUrlEnvKey: 'MINIMAX_CN_BASE_URL',
    envKeys: ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'],
    models: anthropicModels([
      ['MiniMax-M2.5', 'MiniMax M2.5'],
      ['MiniMax-M2.1', 'MiniMax M2.1'],
    ]),
    reasoningLevels,
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Coding',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.moonshot.ai/v1',
    baseUrlEnvKey: 'KIMI_BASE_URL',
    envKeys: ['KIMI_API_KEY'],
    models: openAiModels([
      ['kimi-k2.5', 'Kimi K2.5'],
      ['kimi-k2-thinking', 'Kimi K2 Thinking'],
      ['kimi-k2', 'Kimi K2'],
    ]),
    reasoningLevels,
  },
  {
    id: 'kimi-coding-cn',
    label: 'Kimi Coding China',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlEnvKey: 'KIMI_CN_BASE_URL',
    envKeys: ['KIMI_CN_API_KEY', 'KIMI_API_KEY'],
    models: openAiModels([
      ['kimi-k2.5', 'Kimi K2.5'],
      ['kimi-k2-thinking', 'Kimi K2 Thinking'],
      ['kimi-k2', 'Kimi K2'],
    ]),
    reasoningLevels,
  },
  {
    id: 'alibaba',
    label: 'Alibaba / DashScope',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvKey: 'DASHSCOPE_BASE_URL',
    envKeys: ['DASHSCOPE_API_KEY'],
    models: openAiModels([
      ['qwen-plus', 'Qwen Plus'],
      ['qwen-max', 'Qwen Max'],
      ['qwen3-coder-plus', 'Qwen3 Coder Plus'],
    ]),
    reasoningLevels,
  },
  {
    id: 'alibaba-coding-plan',
    label: 'Alibaba Coding Plan',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnvKey: 'ALIBABA_CODING_PLAN_BASE_URL',
    envKeys: ['ALIBABA_CODING_PLAN_API_KEY', 'DASHSCOPE_API_KEY'],
    models: openAiModels([
      ['qwen3-coder-plus', 'Qwen3 Coder Plus'],
      ['qwen3-coder-next', 'Qwen3 Coder Next'],
    ]),
    reasoningLevels,
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    baseUrlEnvKey: 'XIAOMI_BASE_URL',
    envKeys: ['XIAOMI_API_KEY'],
    models: openAiModels([
      ['mimo-v2-flash', 'MiMo V2 Flash'],
      ['mimo-v2-pro', 'MiMo V2 Pro'],
    ]),
    reasoningLevels,
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://router.huggingface.co/v1',
    baseUrlEnvKey: 'HF_BASE_URL',
    envKeys: ['HF_TOKEN'],
    models: openAiModels([
      ['meta-llama/Llama-3.3-70B-Instruct', 'Llama 3.3 70B Instruct'],
      ['Qwen/Qwen3-235B-A22B', 'Qwen3 235B'],
    ]),
    reasoningLevels,
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    baseUrlEnvKey: 'FIREWORKS_BASE_URL',
    envKeys: ['FIREWORKS_API_KEY'],
    models: openAiModels([
      ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'Llama 3.1 70B'],
      ['accounts/fireworks/models/deepseek-v3', 'DeepSeek V3'],
    ]),
    reasoningLevels,
  },
  {
    id: 'novita',
    label: 'Novita AI',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.novita.ai/openai',
    baseUrlEnvKey: 'NOVITA_BASE_URL',
    envKeys: ['NOVITA_API_KEY'],
    models: openAiModels([
      ['deepseek/deepseek-v3-0324', 'DeepSeek V3'],
      ['meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B'],
    ]),
    reasoningLevels,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    baseUrlEnvKey: 'NVIDIA_BASE_URL',
    envKeys: ['NVIDIA_API_KEY'],
    models: openAiModels([
      ['meta/llama-3.3-70b-instruct', 'Llama 3.3 70B'],
      ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Llama Nemotron Ultra'],
    ]),
    reasoningLevels,
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    baseUrlEnvKey: 'DEEPINFRA_BASE_URL',
    envKeys: ['DEEPINFRA_API_KEY'],
    models: openAiModels([
      ['meta-llama/Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B'],
      ['deepseek-ai/DeepSeek-V3', 'DeepSeek V3'],
    ]),
    reasoningLevels,
  },
  {
    id: 'gmi',
    label: 'GMI Serving',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.gmi-serving.com/v1',
    baseUrlEnvKey: 'GMI_BASE_URL',
    envKeys: ['GMI_API_KEY'],
    models: openAiModels([
      ['gmi-default', 'GMI default model'],
    ]),
    reasoningLevels,
  },
  {
    id: 'arcee',
    label: 'Arcee AI',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.arcee.ai/api/v1',
    baseUrlEnvKey: 'ARCEE_BASE_URL',
    envKeys: ['ARCEE_API_KEY'],
    models: openAiModels([
      ['virtuoso-large', 'Virtuoso Large'],
      ['coder-large', 'Coder Large'],
    ]),
    reasoningLevels,
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    baseUrlEnvKey: 'STEPFUN_BASE_URL',
    envKeys: ['STEPFUN_API_KEY'],
    models: openAiModels([
      ['step-3.5-flash', 'Step 3.5 Flash'],
      ['step-3', 'Step 3'],
    ]),
    reasoningLevels,
  },
  {
    id: 'upstage',
    label: 'Upstage Solar',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.upstage.ai/v1',
    baseUrlEnvKey: 'UPSTAGE_BASE_URL',
    envKeys: ['UPSTAGE_API_KEY'],
    models: openAiModels([
      ['solar-pro2', 'Solar Pro 2'],
      ['solar-mini', 'Solar Mini'],
    ]),
    reasoningLevels,
  },
  {
    id: 'kilocode',
    label: 'KiloCode',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://api.kilo.ai/v1',
    baseUrlEnvKey: 'KILOCODE_BASE_URL',
    envKeys: ['KILOCODE_API_KEY'],
    models: openAiModels([
      ['kilo-default', 'KiloCode default model'],
    ]),
    reasoningLevels,
  },
  {
    id: 'ai-gateway',
    label: 'AI Gateway',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    baseUrlEnvKey: 'AI_GATEWAY_BASE_URL',
    envKeys: ['AI_GATEWAY_API_KEY'],
    models: openAiModels([
      ['openai/gpt-4o', 'OpenAI GPT-4o'],
      ['anthropic/claude-sonnet-4', 'Claude Sonnet'],
    ]),
    reasoningLevels,
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://opencode.ai/zen/v1',
    baseUrlEnvKey: 'OPENCODE_ZEN_BASE_URL',
    envKeys: ['OPENCODE_API_KEY'],
    models: openAiModels([
      ['big-pickle', 'Big Pickle'],
      ['claude-sonnet', 'Claude Sonnet'],
    ]),
    reasoningLevels,
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    baseUrlEnvKey: 'OPENCODE_GO_BASE_URL',
    envKeys: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    models: openAiModels([
      ['minimax-m3', 'MiniMax M3'],
      ['kimi-k3', 'Kimi K3'],
      ['glm-5', 'GLM-5'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ]),
    reasoningLevels,
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    transport: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://ollama.com/v1',
    baseUrlEnvKey: 'OLLAMA_BASE_URL',
    envKeys: ['OLLAMA_API_KEY'],
    models: openAiModels([
      ['gpt-oss:120b', 'GPT OSS 120B'],
      ['qwen3:235b', 'Qwen3 235B'],
    ]),
    reasoningLevels,
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    transport: 'bedrock-converse',
    auth: 'cloud',
    authMethods: ['cli'],
    command: 'aws configure',
    commandHelp: 'Configure the AWS CLI credentials used by the Bedrock runtime.',
    baseUrl: 'bedrock://runtime',
    envKeys: [],
    models: models([
      ['anthropic.claude-3-7-sonnet-20250219-v1:0', 'Claude 3.7 Sonnet'],
      ['amazon.nova-pro-v1:0', 'Amazon Nova Pro'],
      ['meta.llama3-3-70b-instruct-v1:0', 'Llama 3.3 70B'],
    ]),
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    transport: 'vertex-openai',
    auth: 'cloud',
    authMethods: ['cli'],
    command: 'gcloud auth application-default login',
    commandHelp: 'Sign in with Google Application Default Credentials for Vertex AI.',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    envKeys: [],
    projectEnvKey: 'GOOGLE_CLOUD_PROJECT',
    locationEnvKey: 'GOOGLE_CLOUD_LOCATION',
    models: openAiModels([
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ]),
  },
  {
    id: 'azure-foundry',
    label: 'Azure AI Foundry',
    transport: 'azure-openai',
    auth: 'api-key',
    baseUrl: '',
    baseUrlEnvKey: 'AZURE_FOUNDRY_ENDPOINT',
    envKeys: ['AZURE_FOUNDRY_API_KEY'],
    deploymentEnvKey: 'AZURE_FOUNDRY_DEPLOYMENT',
    models: openAiModels([
      ['gpt-4.1', 'GPT-4.1 deployment'],
      ['claude-sonnet-4', 'Claude Sonnet deployment'],
    ]),
    reasoningLevels,
  },
];

const execFileAsync = promisify(execFile);

async function commandAvailable(command: string): Promise<boolean> {
  try {
    const result = await execFileAsync('which', [command], { timeout: 5_000, maxBuffer: 16 * 1024 });
    return Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}

async function readGitHubCliToken(): Promise<string | null> {
  for (const command of ['gh', join(homedir(), '.local', 'bin', 'gh')]) {
    try {
      const result = await execFileAsync(command, ['auth', 'token'], { timeout: 5_000, maxBuffer: 16 * 1024 });
      const token = result.stdout.trim();
      if (token) return token;
    } catch {
      // Try the next known installation path without exposing command errors.
    }
  }
  return null;
}

async function readClaudeConsoleOAuthToken(): Promise<string | null> {
  let authStatus: { authMethod?: string; apiProvider?: string } | null = null;
  const statusEnv = { ...process.env };
  delete statusEnv.ANTHROPIC_API_KEY;
  delete statusEnv.ANTHROPIC_AUTH_TOKEN;
  delete statusEnv.CLAUDE_CODE_OAUTH_TOKEN;
  for (const command of ['claude', join(homedir(), '.local', 'bin', 'claude')]) {
    try {
      const result = await execFileAsync(command, ['auth', 'status', '--json'], {
        timeout: 5_000,
        maxBuffer: 32 * 1024,
        env: statusEnv,
      });
      authStatus = JSON.parse(result.stdout) as { authMethod?: string; apiProvider?: string };
      break;
    } catch {
      // Try the next known installation path without exposing command errors.
    }
  }
  const authMethod = authStatus?.authMethod?.toLowerCase();
  const apiProvider = authStatus?.apiProvider?.toLowerCase();
  if (authMethod !== 'console' && apiProvider !== 'console') return null;
  try {
    const credentials = JSON.parse(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = credentials.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

async function readVertexAccessToken(): Promise<string | null> {
  if (!(await commandAvailable('gcloud'))) return null;
  try {
    const result = await execFileAsync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      timeout: 15_000,
      maxBuffer: 32 * 1024,
    });
    const token = result.stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function hasAwsCredentials(): Promise<boolean> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return true;
  if (process.env.AWS_PROFILE || process.env.AWS_ROLE_ARN) return true;
  const candidates = [
    process.env.AWS_SHARED_CREDENTIALS_FILE,
    join(homedir(), '.aws', 'credentials'),
    join(homedir(), '.aws', 'config'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Check the next AWS configuration source.
    }
  }
  return false;
}

function providerVaultName(providerId: string): string {
  return `terminal-v4:provider:${providerId}`;
}

function readVaultCredential(userId: string | undefined, providerId: string): string | null {
  if (!userId) return null;
  try {
    const row = getDatabase().prepare(
      'SELECT key_value FROM api_key_vault WHERE user_id = ? AND key_name = ?'
    ).get(userId, providerVaultName(providerId)) as { key_value?: string } | undefined;
    if (!row?.key_value) return null;
    return decryptSecret(row.key_value);
  } catch {
    return null;
  }
}

const LOCAL_NO_AUTH_CREDENTIAL = 'terminal-v4-local-noauth';

function isLoopbackBaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

interface ResolvedProviderCredential {
  credential: string;
  kind: ProviderCredentialKind;
}

async function resolveProviderCredentialInfo(definition: ProviderDefinition, env = process.env, userId?: string): Promise<ResolvedProviderCredential | null> {
  const vaultCredential = readVaultCredential(userId, definition.id);
  if (vaultCredential && (definition.authMethods || [definition.auth]).includes('api-key')) {
    return { credential: vaultCredential, kind: 'api-key' };
  }
  for (const key of definition.envKeys) {
    const value = env[key];
    if (value?.trim()) return { credential: value.trim(), kind: 'api-key' };
  }
  if (definition.id === 'anthropic-api') {
    const oauthCredential = await readClaudeConsoleOAuthToken();
    if (oauthCredential) return { credential: oauthCredential, kind: 'oauth' };
  }
  if (definition.id === 'copilot') {
    const credential = await readGitHubCliToken();
    return credential ? { credential, kind: 'oauth' } : null;
  }
  if (definition.transport === 'vertex-openai') {
    const credential = await readVertexAccessToken();
    return credential ? { credential, kind: 'oauth' } : null;
  }
  if (definition.allowLocalNoAuth && isLoopbackBaseUrl(apiEndpoint(definition, env))) {
    return { credential: LOCAL_NO_AUTH_CREDENTIAL, kind: 'api-key' };
  }
  return null;
}

async function providerConfigured(definition: ProviderDefinition, userId?: string): Promise<boolean> {
  if (definition.transport === 'virtual') return false;
  if (definition.transport === 'external-cli') return Boolean(definition.command && await commandAvailable(definition.command));
  if (definition.transport === 'bedrock-converse') return hasAwsCredentials();
  if (definition.requiresBaseUrl && !apiEndpoint(definition)) return false;
  const credential = await resolveProviderCredentialInfo(definition, process.env, userId);
  if (!credential) return false;
  if (definition.transport === 'vertex-openai') {
    return Boolean(definition.projectEnvKey && process.env[definition.projectEnvKey]?.trim());
  }
  if (definition.transport === 'azure-openai') {
    return Boolean(
      definition.baseUrlEnvKey && process.env[definition.baseUrlEnvKey]?.trim()
      && definition.deploymentEnvKey && process.env[definition.deploymentEnvKey]?.trim(),
    );
  }
  return true;
}

export async function resolveProviderCredential(definition: ProviderDefinition, env = process.env, userId?: string): Promise<string | null> {
  return (await resolveProviderCredentialInfo(definition, env, userId))?.credential || null;
}

export async function loadApiProviderStates(userId?: string): Promise<ProviderRuntimeState[]> {
  const states = await Promise.all(API_PROVIDER_DEFINITIONS.map(async definition => {
    if (definition.transport === 'virtual') {
      return { definition, status: 'not-configured' as const, authenticated: false };
    }
    const configured = await providerConfigured(definition, userId);
    const status: ProviderRuntimeStatus = definition.transport === 'external-cli' && !configured
      ? 'not-installed'
      : configured ? 'ready' : 'auth-required';
    return { definition, status, authenticated: configured };
  }));
  const dependenciesReady = ['xai', 'deepseek'].every(providerId =>
    states.some(state => state.definition.id === providerId && state.status === 'ready'),
  );
  return states.map(state => state.definition.id === 'moa' && dependenciesReady
    ? { ...state, status: 'ready' as const, authenticated: true }
    : state);
}

export async function getProviderCredential(providerId: string, userId?: string): Promise<{ definition: ProviderDefinition; credential: string | null; credentialKind: ProviderCredentialKind | null }> {
  const definition = API_PROVIDER_DEFINITIONS.find(candidate => candidate.id === providerId);
  if (!definition) throw new Error(`Unknown API provider: ${providerId}`);
  const resolved = await resolveProviderCredentialInfo(definition, process.env, userId);
  return { definition, credential: resolved?.credential || null, credentialKind: resolved?.kind || null };
}

export function apiEndpoint(definition: ProviderDefinition, env = process.env): string {
  const configured = definition.baseUrlEnvKey ? env[definition.baseUrlEnvKey]?.trim() : '';
  const normalized = (configured || definition.baseUrl).replace(/\/$/, '');
  if (definition.id === 'actual' && normalized && !/\/v1$/i.test(normalized)) return `${normalized}/v1`;
  return normalized;
}

export function vertexEndpoint(definition: ProviderDefinition, env = process.env): string {
  const project = definition.projectEnvKey ? env[definition.projectEnvKey]?.trim() : '';
  const location = (definition.locationEnvKey ? env[definition.locationEnvKey]?.trim() : '') || 'us-central1';
  if (!project) throw new Error('Google Vertex AI requires GOOGLE_CLOUD_PROJECT');
  const host = apiEndpoint(definition, env).replace(/^https?:\/\//, '').replace(/^us-central1-/, `${location}-`);
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi/chat/completions`;
}

export function azureFoundryEndpoint(definition: ProviderDefinition, env = process.env): string {
  const base = apiEndpoint(definition, env);
  const deployment = definition.deploymentEnvKey ? env[definition.deploymentEnvKey]?.trim() : '';
  if (!base || !deployment) throw new Error('Azure AI Foundry requires AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_DEPLOYMENT');
  return `${base.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-10-21`;
}

export function safeProviderError(status: number, body: string): Error {
  const sanitized = body
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|xai|ghp|dsk|hf|nvapi|ya29)-[A-Za-z0-9._~-]{12,}/gi, '[redacted credential]')
    .slice(0, 300)
    .replace(/[\r\n]+/g, ' ');
  return new Error(`Provider request failed (${status}): ${sanitized}`);
}

export async function providerConfigExists(): Promise<boolean> {
  return API_PROVIDER_DEFINITIONS.some(definition => definition.envKeys.some(key => Boolean(process.env[key])));
}

export async function awsCredentialsAvailable(): Promise<boolean> {
  return hasAwsCredentials();
}

export async function vertexAccessToken(): Promise<string | null> {
  return readVertexAccessToken();
}
