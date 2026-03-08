import { describe, expect, it } from 'vitest';
import {
  deriveTopicFromSubmittedInput,
  extractTopicFromTerminalText,
  isIgnorableTopicInput,
} from './session-topic';

describe('deriveTopicFromSubmittedInput', () => {
  it('keeps a natural-language prompt as the topic', () => {
    expect(deriveTopicFromSubmittedInput('Explain this codebase')).toBe('Explain this codebase');
  });

  it('ignores built-in AI launcher commands', () => {
    expect(deriveTopicFromSubmittedInput('codex --yolo')).toBeNull();
    expect(deriveTopicFromSubmittedInput('claude --dangerously-skip-permissions')).toBeNull();
    expect(deriveTopicFromSubmittedInput('gemini --yolo')).toBeNull();
  });

  it('ignores slash launchers and shell commands', () => {
    expect(deriveTopicFromSubmittedInput('/codex')).toBeNull();
    expect(deriveTopicFromSubmittedInput('npm run build')).toBeNull();
  });
});

describe('isIgnorableTopicInput', () => {
  it('treats custom launcher-like commands with flags as ignorable bootstrap input', () => {
    expect(isIgnorableTopicInput('qwen --fast')).toBe(true);
  });
});

describe('extractTopicFromTerminalText', () => {
  it('prefers the first real prompt over launcher noise in terminal history', () => {
    const text = [
      '> codex --yolo',
      'OpenAI Codex v0.0.0',
      '> Explain this codebase',
      'Sure, I will inspect the repository first.'
    ].join('\n');

    expect(extractTopicFromTerminalText(text)).toBe('Explain this codebase');
  });
});
