import type { TerminalManager } from '../terminal/terminal-manager';
import type { ClaudeCodeManager } from '../claude-code/claude-code-manager';

export interface CoreRouteDependencies {
  terminalManager: TerminalManager;
  claudeCodeManager: ClaudeCodeManager;
}

export interface TerminalIdParams {
  id: string;
}
