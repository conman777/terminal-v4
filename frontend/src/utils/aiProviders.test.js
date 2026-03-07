import { describe, expect, it } from 'vitest';
import {
  AI_TYPE_OPTIONS,
  COMMON_LAUNCH_PREFIXES,
  NEW_TAB_AI_OPTIONS,
  getAiCapabilities,
  getAiDisplayLabel,
  getAiInitialCommand,
  getAiLaunchCommand,
  inferSessionAiType,
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
    expect(getAiDisplayLabel('deepseek')).toBe('Deepseek');
    expect(getAiLaunchCommand('deepseek')).toBe('deepseek');
    expect(getAiCapabilities('deepseek').supportsStructuredEvents).toBe(false);
  });

  it('exposes extended provider options for new tabs and context menus', () => {
    expect(NEW_TAB_AI_OPTIONS.some((option) => option.id === 'codex')).toBe(true);
    expect(AI_TYPE_OPTIONS.some((option) => option.id === 'claude')).toBe(true);
    expect(COMMON_LAUNCH_PREFIXES).toContain('gemini');
  });

  it('exposes capability matrix for supported providers', () => {
    expect(getAiCapabilities('claude').supportsPromptEvents).toBe(true);
    expect(getAiCapabilities('codex').prefersStructuredUi).toBe(true);
  });

  it('infers a provider from session shell or title when explicit aiType is missing', () => {
    expect(inferSessionAiType({ shell: 'claude', title: 'Terminal 1' })).toBe('claude');
    expect(inferSessionAiType({ title: 'OpenAI Codex' })).toBe('codex');
    expect(inferSessionAiType({ shell: 'pwsh', title: 'Gemini CLI' })).toBe('gemini');
  });
});
