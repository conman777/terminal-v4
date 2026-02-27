/**
 * Detects conversation turns from the live PTY stream and from history entries.
 *
 * The TurnDetector sits alongside the PTY process inside ManagedTerminal.
 * It observes raw PTY output and user input, detects Claude Code's prompt
 * pattern to find response boundaries, and emits structured {role, content, ts}
 * turns via an onTurn callback.
 *
 * The same ANSI-stripping / UI-chrome-filtering logic is also exposed as
 * buildTurnsFromHistory() for the HTTP /turns endpoint to process stored history.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

// A line that consists only of Claude Code's prompt character signals end-of-response.
const PROMPT_ONLY_LINE_RE = /^\s*[>❯]\s*$/m;

// Debounce interval before checking for the prompt after PTY output stops.
const IDLE_TIMEOUT_MS = 500;

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[NO][\s\S]/g, '')
    .replace(/\x1b[\s\S]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function isUiChrome(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t === '[terminated]') return true;
  if (/^\[\w+\]$/.test(t)) return true;
  if (/\(esc to interrupt/i.test(t)) return true;
  if (/\(ctrl\+c to interrupt/i.test(t)) return true;
  if (/\bctrl\+t to show todos\b/i.test(t)) return true;
  if (/\(thinking\)\s*$/.test(t)) return true;
  if (/\b\d+(?:\.\d+)?k?\s+tokens?\)\s*$/.test(t)) return true;
  if (/^\d+(?:\.\d+)?k?\s+tokens?\)?$/.test(t)) return true;
  if (/ctrl\+b\s+ctrl\+b/i.test(t)) return true;
  if (/ctrl\+o to expand/i.test(t)) return true;
  if (/bypass permissions/i.test(t)) return true;
  if (/shift\+tab.*cycle/i.test(t)) return true;
  if (/^[●○]\s*(Read|Edit|Bash|Glob|Grep|Search|Explore|Write|MultiEdit|LS|Task|Todo|Notebook|WebFetch)\(/.test(t)) return true;
  if (/^(Read|Edit|Bash|Glob|Grep|Search|Explore|Write|MultiEdit|LS|Task|Todo|Notebook|WebFetch)\(/.test(t)) return true;
  if (/^⎿/.test(t)) return true;
  if (/^\+\d+\s+more\s+(tool uses|lines?)\b/.test(t)) return true;
  if (/^\* (Computing|Musing|Unravelling|Building|Updating )/.test(t)) return true;
  if (/^[✶✻✽✢·*]\s+(Computing|Musing|Unravelling|Updating )/.test(t)) return true;
  if (/^(Waiting…|Running…)\s*$/.test(t)) return true;
  if (/^Added \d+ lines?$/.test(t)) return true;
  if (/^Next: /.test(t)) return true;
  if (/^\s*[>❯]\s*$/.test(t)) return true;
  if (/^\s*[>❯]\s*[─\-]{10,}/.test(t)) return true;
  if (/^\s*[^@\s]+@[^:\s]+:/.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  if (/^[\s─═━\-─═━>│╭╰╯╮╱╲]+$/.test(t)) return true;
  if (/^[\s│]+\.[\s│.·]+$/.test(t)) return true;
  return false;
}

// Handle \r (carriage return = overwrite from line start).
function applyCarriageReturns(line: string): string {
  const parts = line.split('\r');
  let result = '';
  for (const part of parts) {
    if (part.length >= result.length) {
      result = part;
    } else {
      result = part + result.slice(part.length);
    }
  }
  return result;
}

function extractContent(rawBuffer: string): string {
  const stripped = stripAnsi(rawBuffer);
  return stripped
    .split('\n')
    .map(applyCarriageReturns)
    .filter(line => !isUiChrome(line))
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Detects conversation turns from the live PTY stream.
 * One instance lives inside each ManagedTerminal for the session's lifetime.
 */
export class TurnDetector {
  private outputBuffer = '';
  private lastOutputTs = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onTurn: (turn: ChatTurn) => void;

  constructor(onTurn: (turn: ChatTurn) => void) {
    this.onTurn = onTurn;
  }

  onUserInput(text: string): void {
    // Flush any pending assistant output before recording user input.
    this.flushAssistant();
    const cleaned = stripAnsi(text).replace(/[\r\n]+$/, '').trim();
    // Skip single-key presses, control chars, and empty strings.
    if (cleaned.length >= 2) {
      this.onTurn({ role: 'user', content: cleaned, ts: Date.now() });
    }
  }

  onPtyOutput(raw: string, ts: number): void {
    this.outputBuffer += raw;
    this.lastOutputTs = ts;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.checkAndFlush();
    }, IDLE_TIMEOUT_MS);
  }

  private checkAndFlush(): void {
    if (!this.outputBuffer) return;
    if (PROMPT_ONLY_LINE_RE.test(stripAnsi(this.outputBuffer))) {
      this.flushAssistant();
    }
  }

  private flushAssistant(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const buffer = this.outputBuffer;
    this.outputBuffer = '';
    if (!buffer) return;
    const content = extractContent(buffer);
    if (content) {
      this.onTurn({ role: 'assistant', content, ts: this.lastOutputTs });
    }
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.outputBuffer = '';
  }
}

/**
 * Parse structured turns from raw history entries (used by the HTTP /turns endpoint).
 * Applies the same prompt-detection logic as the live TurnDetector but synchronously
 * over the combined history text.
 */
export function buildTurnsFromHistory(
  entries: Array<{ text: string; ts: number }>,
): ChatTurn[] {
  if (!entries.length) return [];

  const combined = entries.map(e => e.text).join('');
  const lastTs = entries[entries.length - 1]?.ts ?? Date.now();
  const stripped = stripAnsi(combined);
  const rawLines = stripped.split('\n');

  const turns: ChatTurn[] = [];
  let currentRole: 'user' | 'assistant' = 'assistant';
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines
      .map(applyCarriageReturns)
      .filter(l => !isUiChrome(l))
      .map(l => l.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (content) {
      turns.push({ role: currentRole, content, ts: lastTs + turns.length });
    }
    currentLines = [];
  };

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, '');
    const promptMatch = line.match(/^\s*[>❯]\s?(.*)$/);
    if (promptMatch) {
      flush();
      currentRole = 'user';
      const promptText = (promptMatch[1] || '').trim();
      if (promptText) {
        currentLines = [promptText];
        flush();
      } else {
        currentLines = [];
      }
      currentRole = 'assistant';
      continue;
    }
    currentLines.push(line);
  }

  flush();
  return turns;
}
