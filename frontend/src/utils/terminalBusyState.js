const ANSI_ESCAPE_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()][A-Z0-9]|\x1b[NO][\s\S]|\x1b[\s\S]/g;

const SHELL_PROMPT_PATTERNS = [
  /^[A-Za-z]:\\[^>\r\n]*>\s*$/,
  /^\s*PS [^\r\n>]+>\s*$/,
  /^\s*[^@\s\r\n]+@[^:\s\r\n]+:[^#$\r\n]*[$#]\s*$/,
  /^\s*[^@\s\r\n]+@[^\s\r\n:]+ [^\r\n%]*%\s*$/
];

const IDLE_PROMPT_PATTERNS = [
  ...SHELL_PROMPT_PATTERNS,
  /^\s*[>❯]\s*$/
];

function stripAnsi(value) {
  return String(value || '').replace(ANSI_ESCAPE_RE, '');
}

function getLastVisibleLine(value) {
  const lines = value
    .split('\n')
    .map((line) => line.trimEnd());

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) {
      return lines[index];
    }
  }

  return '';
}

function lastLineMatches(output, patterns) {
  if (!output) return false;
  const normalized = stripAnsi(output).replace(/\r/g, '');
  const lastLine = getLastVisibleLine(normalized);
  return lastLine.length > 0 && patterns.some((pattern) => pattern.test(lastLine));
}

export function outputIndicatesTerminalIdle(output) {
  return lastLineMatches(output, IDLE_PROMPT_PATTERNS);
}

export function screenShowsShellPrompt(screen) {
  return lastLineMatches(screen, SHELL_PROMPT_PATTERNS);
}

export function cliEventIndicatesTerminalIdle(event) {
  return event?.type === 'assistant_turn' || event?.type === 'prompt_required';
}
