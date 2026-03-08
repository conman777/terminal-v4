const ANSI_ESCAPE_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()][A-Z0-9]|\x1b[NO][\s\S]|\x1b[\s\S]/g;

const IDLE_PROMPT_PATTERNS = [
  /^[A-Za-z]:\\[^>\r\n]*>\s*$/,
  /^\s*PS [^\r\n>]+>\s*$/,
  /^\s*[^@\s\r\n]+@[^:\s\r\n]+:[^#$\r\n]*[$#]\s*$/,
  /^\s*[>❯]\s*$/
];

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, '');
}

function getLastVisibleLine(value: string): string {
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

export function outputIndicatesIdlePrompt(output: string): boolean {
  if (!output) return false;
  const normalized = stripAnsi(output).replace(/\r/g, '');
  const lastLine = getLastVisibleLine(normalized);
  return lastLine.length > 0 && IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}
