const FALLBACK_TERM = 'xterm-256color';
const FALLBACK_COLOR_TERM = 'truecolor';
const FALLBACK_TERM_PROGRAM = 'terminal-v4';

function isDumbTerm(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'dumb';
}

export function buildInteractiveTerminalEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };

  // Remove Claude Code's nesting guard so terminals can launch claude independently
  delete env.CLAUDECODE;

  if (!env.TERM || isDumbTerm(env.TERM)) {
    env.TERM = FALLBACK_TERM;
  }

  if (!env.COLORTERM || isDumbTerm(env.COLORTERM)) {
    env.COLORTERM = FALLBACK_COLOR_TERM;
  }

  if (!env.TERM_PROGRAM) {
    env.TERM_PROGRAM = FALLBACK_TERM_PROGRAM;
  }

  return env;
}
