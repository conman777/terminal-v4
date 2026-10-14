import { describe, expect, it } from 'vitest';
import {
  AI_TYPE_OPTIONS,
  COMMON_LAUNCH_PREFIXES,
  NEW_TAB_AI_OPTIONS,
  buildAgentLaunchCommand,
  createCustomAiProvider,
  getAiCapabilities,
  getAiComposerSlashCommands,
  getAiDisplayLabel,
  getAiInitialCommand,
  getAiLaunchCommand,
  getAiTypeOptions,
  inferSessionAiType,
  shouldCreateStructuredSession,
  rewriteTerminalAgentInput,
  resolveSlashAgentCommand
} from './aiProviders';

describe('aiProviders', () => {
  it('returns known labels and launch commands', () => {
    expect(getAiDisplayLabel('claude')).toBe('Claude Code');
    expect(getAiDisplayLabel('gemini')).toBe('Gemini');
    expect(getAiLaunchCommand('codex')).toBe('codex');
    expect(getAiInitialCommand('codex')).toBe('codex --yolo');
  });

  it('resolves slash agent aliases to launchable shell commands', () => {
    expect(resolveSlashAgentCommand('/codex')).toBe('codex --yolo');
    expect(resolveSlashAgentCommand('/claude')).toBe('claude --dangerously-skip-permissions');
    expect(resolveSlashAgentCommand('/gemni')).toBe('gemini --yolo');
    expect(resolveSlashAgentCommand('/codex --approval-mode auto')).toBe('codex --approval-mode auto');
    expect(resolveSlashAgentCommand('/model')).toBeNull();
  });

  it('rewrites terminal input lines while preserving submit newlines', () => {
    expect(rewriteTerminalAgentInput('/codex\r')).toBe('codex --yolo\r');
    expect(rewriteTerminalAgentInput('/claude\r\n')).toBe('claude --dangerously-skip-permissions\r\n');
    expect(rewriteTerminalAgentInput('/gemni\n')).toBe('gemini --yolo\n');
    expect(rewriteTerminalAgentInput('/model\r')).toBe('/model\r');
  });

  it('falls back for unknown providers', () => {
    expect(getAiDisplayLabel('deepseek')).toBe('DeepSeek');
    expect(getAiLaunchCommand('deepseek')).toBe('terminal-v4-api');
    expect(getAiCapabilities('deepseek').supportsStructuredEvents).toBe(false);
  });

  it('supports custom providers with explicit launch commands', () => {
    const customProvider = createCustomAiProvider('Qwen 3', 'qwen --fast', [], {
      slashCommands: [
        { cmd: '/model', desc: 'Pick model' },
        { cmd: '/clear', desc: 'Reset chat' },
      ]
    });
    expect(customProvider?.id).toBe('qwen-3');
    expect(getAiDisplayLabel('qwen-3', [customProvider])).toBe('Qwen 3');
    expect(getAiInitialCommand('qwen-3', [customProvider])).toBe('qwen --fast');
    expect(getAiComposerSlashCommands('qwen-3', [customProvider])).toEqual([
      { cmd: '/model', desc: 'Pick model' },
      { cmd: '/clear', desc: 'Reset chat' },
    ]);
    expect(getAiTypeOptions([customProvider]).some((option) => option.id === 'qwen-3')).toBe(true);
  });

  it('exposes the full provider catalog in new tabs and builds API launchers for every provider', () => {
    const expectedProviders = [
      'anthropic-api', 'xai', 'xai-oauth', 'openai-api', 'actual', 'copilot', 'deepseek', 'moa', 'openrouter', 'nous',
      'qwen-oauth', 'minimax-oauth', 'copilot-acp', 'lmstudio', 'tencent-tokenhub', 'zai', 'minimax', 'minimax-cn',
      'kimi-coding', 'kimi-coding-cn', 'alibaba', 'alibaba-coding-plan', 'xiaomi',
      'huggingface', 'fireworks', 'novita', 'nvidia', 'deepinfra', 'gmi', 'arcee',
      'stepfun', 'upstage', 'kilocode', 'ai-gateway', 'opencode-zen', 'opencode-go',
      'ollama-cloud', 'bedrock', 'vertex', 'azure-foundry',
    ];
    for (const provider of expectedProviders) {
      expect(NEW_TAB_AI_OPTIONS.some(option => option.id === provider)).toBe(true);
      if (provider !== 'copilot-acp') {
        expect(buildAgentLaunchCommand({ agent: provider, model: 'default-model' })).toContain(`--provider '${provider}'`);
      }
    }
    expect(buildAgentLaunchCommand({ agent: 'copilot-acp', model: 'default' })).toBe('copilot');
  });

  it('exposes extended provider options for new tabs and context menus', () => {
    expect(NEW_TAB_AI_OPTIONS.some((option) => option.id === 'codex')).toBe(true);
    expect(NEW_TAB_AI_OPTIONS.some((option) => option.id === 'legacy-agent')).toBe(false);
    expect(AI_TYPE_OPTIONS.some((option) => option.id === 'claude')).toBe(true);
    expect(COMMON_LAUNCH_PREFIXES).toContain('gemini');
  });

  it('builds native agent model launch commands with shell-safe arguments', () => {
    expect(buildAgentLaunchCommand({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
    })).toBe("codex --model 'gpt-5.6-sol' --config 'model_reasoning_effort=\"xhigh\"'");

    expect(buildAgentLaunchCommand({
      agent: 'claude',
      model: 'sonnet',
      reasoning: 'high',
    })).toBe("claude --model 'sonnet' --effort 'high'");

    expect(buildAgentLaunchCommand({ agent: 'gemini', model: 'gemini-3-flash-preview' }))
      .toBe("gemini --model 'gemini-3-flash-preview'");

    expect(buildAgentLaunchCommand({
      agent: 'copilot',
      model: 'gpt-4o',
      reasoning: 'low',
    })).toBe("node backend/dist/api-agent-runner.js --provider 'copilot' --model 'gpt-4o'");

    expect(() => buildAgentLaunchCommand({
      agent: 'codex',
      model: 'gpt-5.6-sol\nrm -rf /',
    })).toThrow(/invalid/i);
  });

  it('exposes capability matrix for supported providers', () => {
    expect(getAiCapabilities('claude').supportsPromptEvents).toBe(true);
    expect(getAiCapabilities('codex').supportsStructuredEvents).toBe(true);
    expect(shouldCreateStructuredSession('gemini')).toBe(false);
    expect(shouldCreateStructuredSession('cli')).toBe(false);
    expect(getAiComposerSlashCommands('claude')).toContainEqual({
      cmd: '/help',
      desc: 'Show available commands'
    });
  });

  it('infers a provider from session shell or title when explicit aiType is missing', () => {
    expect(inferSessionAiType({ shell: 'claude', title: 'Terminal 1' })).toBe('claude');
    expect(inferSessionAiType({ shell: 'bash', thread: { aiType: 'codex' } })).toBe('codex');
    expect(inferSessionAiType({ title: 'OpenAI Codex' })).toBe('codex');
    expect(inferSessionAiType({ shell: 'pwsh', title: 'Gemini CLI' })).toBe('gemini');
  });
});
