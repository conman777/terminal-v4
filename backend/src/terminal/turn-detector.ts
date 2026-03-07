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
import type { TerminalCliEvent, TerminalCliPromptEvent, TerminalCliPromptOption } from './cli-events';
import { buildCliTurnEvent } from './cli-events';

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
  const squashed = squash(t);
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
  if (/^\s*[>❯]\s+/.test(t)) return true;
  if (/^\s*[>❯]\s*[─\-]{10,}/.test(t)) return true;
  if (/^[A-Za-z]:\\[^>]*>\s*$/.test(t)) return true;
  if (/^[A-Za-z]:\\[^>]*>\S.+$/.test(t)) return true;
  if (/^\s*[^@\s]+@[^:\s]+:/.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  if (/^[\s─═━\-─═━>│╭╰╯╮╱╲]+$/.test(t)) return true;
  if (/^[\s│]+\.[\s│.·]+$/.test(t)) return true;
  if (
    (t.includes('|') || /[🪟💰🔥🧠]/u.test(t))
    && (
      squashed.includes('opus4.6')
      || squashed.includes('sonnet4.6')
      || squashed.includes('claudemax')
      || squashed.includes('gpt-5.4')
      || squashed.includes('session/')
      || squashed.includes('today/')
      || squashed.includes('/hr')
      || squashed.includes('%left')
      || /\$\d/.test(t)
    )
  ) return true;
  return false;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function fingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isClaudeBootstrapNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  const squashed = squash(t);

  if (squashed.includes('microsoftwindows[version')) return true;
  if (squashed.includes('(c)microsoftcorporation.allrightsreserved')) return true;
  if (squashed.includes('claudecodev')) return true;
  if (squashed.includes('sonnet4.6') && squashed.includes('claudemax')) return true;
  if (squashed.includes('found1settingsissue') && squashed.includes('/doctor')) return true;
  if (squashed.includes('bypasspermissionson')) return true;
  if (squashed.includes('shift+tabtocycle')) return true;

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

function extractContent(rawBuffer: string, recentUserInputs: string[] = []): string {
  const stripped = stripAnsi(rawBuffer);
  const userFingerprints = new Set(
    recentUserInputs
      .map(fingerprint)
      .filter(fp => fp.length >= 4),
  );

  let lastFingerprint = '';

  return stripped
    .split('\n')
    .map(applyCarriageReturns)
    .filter(line => {
      if (isUiChrome(line)) return false;
      if (isClaudeBootstrapNoise(line)) return false;
      const fp = fingerprint(line);
      if (fp && userFingerprints.has(fp)) return false;
      if (fp && fp === lastFingerprint) return false;
      lastFingerprint = fp;
      return true;
    })
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isInteractiveSafetyPrompt(content: string): boolean {
  if (!content) return false;
  const squashed = content.toLowerCase().replace(/\s+/g, '');
  const hasSafetyPrompt =
    (squashed.includes('accessingworkspace:') || squashed.includes('quicksafetycheck'))
    && (squashed.includes('trustthisfolder') || squashed.includes('createdoroneyoutrust'))
    && (squashed.includes('entertoconfirm') || squashed.includes('esctocancel'));

  if (hasSafetyPrompt) return true;

  const hasChoicePrompt =
    squashed.includes('entertoconfirm')
    && squashed.includes('esctocancel')
    && (squashed.includes('1.yes') || squashed.includes('2.no'));

  return hasChoicePrompt;
}

function buildPromptOptions(lines: string[]): TerminalCliPromptOption[] {
  const numberedOptions = lines
    .map((line, index) => {
      const match = line.match(/^([>❯›]\s*)?(\d+)\.\s+(.+)$/);
      if (!match) return null;
      return {
        index,
        selected: Boolean(match[1]),
        label: `${match[2]}. ${match[3].trim()}`
      };
    })
    .filter((value): value is { index: number; selected: boolean; label: string } => Boolean(value));

  if (numberedOptions.length === 0) return [];

  const selectedIndex = numberedOptions.findIndex((option) => option.selected);
  const baseIndex = selectedIndex >= 0 ? selectedIndex : 0;

  return numberedOptions.map((option, index) => {
    const delta = index - baseIndex;
    const navigation = delta > 0
      ? '\x1b[B'.repeat(delta)
      : '\x1b[A'.repeat(Math.abs(delta));

    return {
      label: option.label,
      payload: `${navigation}\r`,
      kind: option.selected || (selectedIndex === -1 && index === 0) ? 'primary' : 'secondary'
    };
  });
}

function buildInteractivePromptEvent(content: string, ts: number): TerminalCliPromptEvent | null {
  if (!content) return null;

  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const lowerContent = content.toLowerCase();
  const options = buildPromptOptions(lines);
  const actions = new Set<string>();
  const promptLine = lines.find((line) => (
    /update available/i.test(line)
    || /trust this folder/i.test(line)
    || /continue anyway/i.test(line)
    || /select an option/i.test(line)
    || /enter to (confirm|continue)/i.test(line)
    || /press enter to continue/i.test(line)
    || /esc(?:ape)? to cancel/i.test(line)
    || /\[[yYnN]\/[yYnN]\]/.test(line)
  )) || lines[0];

  if (
    isInteractiveSafetyPrompt(content)
    || /\[[yYnN]\/[yYnN]\]/.test(content)
    || /trust this folder|continue anyway/i.test(content)
  ) {
    actions.add('yes');
    actions.add('no');
  }

  if (/enter to (confirm|continue)|press enter to continue/i.test(lowerContent)) {
    actions.add('enter');
  }

  if (/esc(?:ape)? to cancel/i.test(lowerContent)) {
    actions.add('escape');
  }

  if (/shift\+tab to cycle|tab to cycle/i.test(lowerContent)) {
    actions.add('tab');
    actions.add('shift_tab');
  }

  if (actions.size === 0 && options.length === 0) return null;

  return {
    type: 'prompt_required',
    prompt: promptLine,
    actions: [...actions],
    options: options.length > 0 ? options : undefined,
    ts,
    source: 'pty'
  };
}

/**
 * Detects conversation turns from the live PTY stream.
 * One instance lives inside each ManagedTerminal for the session's lifetime.
 */
export class TurnDetector {
  private outputBuffer = '';
  private inputBuffer = '';
  private lastOutputTs = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private recentUserInputs: string[] = [];
  private readonly onTurn: (turn: ChatTurn) => void;
  private readonly onCliEvent?: (event: TerminalCliEvent) => void;

  constructor(onTurn: (turn: ChatTurn) => void, onCliEvent?: (event: TerminalCliEvent) => void) {
    this.onTurn = onTurn;
    this.onCliEvent = onCliEvent;
  }

  onUserInput(text: string): void {
    // Flush any pending assistant output before recording user input.
    this.flushAssistant();
    const cleaned = stripAnsi(text);
    if (!cleaned) return;

    let nextBuffer = this.inputBuffer;
    const committedLines: string[] = [];

    for (let index = 0; index < cleaned.length; index += 1) {
      const char = cleaned[index];

      if (char === '\r' || char === '\n') {
        const committed = nextBuffer.trim();
        if (committed) {
          committedLines.push(committed);
        }
        nextBuffer = '';
        continue;
      }

      if (char === '\x7f' || char === '\b') {
        nextBuffer = nextBuffer.slice(0, -1);
        continue;
      }

      if (char < ' ') {
        continue;
      }

      nextBuffer += char;
    }

    this.inputBuffer = nextBuffer;

    for (const committed of committedLines) {
      if (committed.length < 2) continue;
      const turn: ChatTurn = { role: 'user', content: committed, ts: Date.now() };
      this.onTurn(turn);
      this.onCliEvent?.(buildCliTurnEvent(turn));
      this.recentUserInputs.push(committed);
      if (this.recentUserInputs.length > 5) {
        this.recentUserInputs.shift();
      }
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
    const stripped = stripAnsi(this.outputBuffer);
    if (PROMPT_ONLY_LINE_RE.test(stripped) || buildInteractivePromptEvent(extractContent(this.outputBuffer, this.recentUserInputs), this.lastOutputTs)) {
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
    const content = extractContent(buffer, this.recentUserInputs);
    if (!content) return;

    const promptEvent = buildInteractivePromptEvent(content, this.lastOutputTs);
    if (promptEvent) {
      this.onCliEvent?.(promptEvent);
      return;
    }

    const turn: ChatTurn = { role: 'assistant', content, ts: this.lastOutputTs };
    this.onTurn(turn);
    this.onCliEvent?.(buildCliTurnEvent(turn));
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.outputBuffer = '';
    this.inputBuffer = '';
    this.recentUserInputs = [];
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
  const recentUserInputs: string[] = [];

  const flush = () => {
    const normalizedLines = currentLines
      .map(applyCarriageReturns)
      .map(l => l.trimEnd());

    const content = currentRole === 'assistant'
      ? extractContent(normalizedLines.join('\n'), recentUserInputs)
      : normalizedLines
        .filter(l => !isUiChrome(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const isDuplicatePromptEcho = (() => {
      if (currentRole !== 'user') return false;
      const lastUser = recentUserInputs[recentUserInputs.length - 1];
      if (!lastUser) return false;
      return fingerprint(lastUser) === fingerprint(content);
    })();

    if (content && !isInteractiveSafetyPrompt(content) && !isDuplicatePromptEcho) {
      turns.push({ role: currentRole, content, ts: lastTs + turns.length });
      if (currentRole === 'user') {
        recentUserInputs.push(content);
        if (recentUserInputs.length > 5) {
          recentUserInputs.shift();
        }
      }
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
