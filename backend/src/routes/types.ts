import type { TerminalManager } from '../terminal/terminal-manager';
import type { ClaudeCodeManager } from '../claude-code/claude-code-manager';
import type { StructuredSessionManager } from '../structured/session-manager';

export interface CoreRouteDependencies {
  terminalManager: TerminalManager;
  claudeCodeManager: ClaudeCodeManager;
  structuredSessionManager: StructuredSessionManager;
}

export interface TerminalIdParams {
  id: string;
}
