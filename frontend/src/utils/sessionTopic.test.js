import { describe, expect, it } from 'vitest';
import { getPreferredSessionTopic, isMeaningfulSessionTopic } from './sessionTopic';

describe('isMeaningfulSessionTopic', () => {
  it('accepts natural-language prompts', () => {
    expect(isMeaningfulSessionTopic('Explain this codebase')).toBe(true);
  });

  it('rejects launcher commands and shell commands', () => {
    expect(isMeaningfulSessionTopic('codex --yolo')).toBe(false);
    expect(isMeaningfulSessionTopic('claude --dangerously-skip-permissions')).toBe(false);
    expect(isMeaningfulSessionTopic('npm run build')).toBe(false);
  });
});

describe('getPreferredSessionTopic', () => {
  it('falls back to the session title when the saved topic is launcher noise', () => {
    expect(getPreferredSessionTopic('codex --yolo', 'Claude Workspace')).toBe('Claude Workspace');
  });
});
