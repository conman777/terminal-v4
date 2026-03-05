import { describe, expect, it } from 'vitest';
import { shouldFallbackToTerminalView } from './conversationMode';

describe('shouldFallbackToTerminalView', () => {
  it('returns true for alternate-screen ANSI sequences', () => {
    expect(shouldFallbackToTerminalView('\x1b[?1049h\x1b[2J')).toBe(true);
  });

  it('returns true for Claude trust/safety prompt text', () => {
    const chunk = 'Accessing workspace: C:\\repo Quick safety check! Is this a project you trust? 1.Yes trust this folder 2.No, exit Enter to confirm Esc to cancel';
    expect(shouldFallbackToTerminalView(chunk)).toBe(true);
  });

  it('returns false for normal colorized output', () => {
    const chunk = '\x1b[32mBuild completed successfully\x1b[0m';
    expect(shouldFallbackToTerminalView(chunk)).toBe(false);
  });

  it('returns false for regular assistant content', () => {
    expect(shouldFallbackToTerminalView('I updated the tests and pushed the branch.')).toBe(false);
  });

  it('returns true for generic CLI menu prompts (non-Claude specific)', () => {
    const chunk = 'Select an option. Use arrow keys to navigate. Enter to continue. q to quit.';
    expect(shouldFallbackToTerminalView(chunk)).toBe(true);
  });

  it('returns true for progress/status TUI fragments with prompt markers', () => {
    const chunk = '* Running... > waiting for input';
    expect(shouldFallbackToTerminalView(chunk)).toBe(true);
  });
});
