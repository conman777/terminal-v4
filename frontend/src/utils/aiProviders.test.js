import { describe, expect, it } from 'vitest';
import {
  AI_TYPE_OPTIONS,
  COMMON_LAUNCH_PREFIXES,
  NEW_TAB_AI_OPTIONS,
  getAiCapabilities,
  getAiDisplayLabel,
  getAiLaunchCommand,
  inferSessionAiType
} from './aiProviders';

describe('aiProviders', () => {
  it('returns known labels and launch commands', () => {
    expect(getAiDisplayLabel('claude')).toBe('Claude Code');
    expect(getAiDisplayLabel('gemini')).toBe('Gemini');
    expect(getAiLaunchCommand('codex')).toBe('codex');
  });

  it('falls back for unknown providers', () => {
    expect(getAiDisplayLabel('deepseek')).toBe('Deepseek');
    expect(getAiLaunchCommand('deepseek')).toBe('deepseek');
    expect(getAiCapabilities('deepseek').supportsStructuredEvents).toBe(false);
  });

  it('exposes extended provider options for new tabs and context menus', () => {
    expect(NEW_TAB_AI_OPTIONS.some((option) => option.id === 'aider')).toBe(true);
    expect(AI_TYPE_OPTIONS.some((option) => option.id === 'ollama')).toBe(true);
    expect(COMMON_LAUNCH_PREFIXES).toContain('qwen');
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
