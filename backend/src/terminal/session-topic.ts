const KNOWN_LAUNCH_PREFIXES = new Set([
  'claude',
  'codex',
  'gemini',
]);

function normalizeTopicLine(raw: string): string {
  return raw
    .replace(/\x1b\(B/g, '')
    .replace(/[Â·â€¢]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyShellCommand(line: string): boolean {
  return /^(cd|ls|pwd|git|npm|pnpm|yarn|bun|node|python|pip|cargo|go|make|bash|sh|zsh|cat|rg|grep|sed|awk|jq|chmod|chown|mv|cp|rm|mkdir|touch)\b/i.test(line);
}

function isLaunchCommand(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return false;

  if (/^\/[a-z0-9._:-]+(?:\s|$)/i.test(normalized)) {
    return true;
  }

  const [firstToken = ''] = normalized.split(/\s+/, 1);
  if (KNOWN_LAUNCH_PREFIXES.has(firstToken)) {
    return true;
  }

  return /\s--?[a-z0-9][\w-]*/i.test(normalized);
}

export function isIgnorableTopicInput(raw: string): boolean {
  const line = normalizeTopicLine(raw);
  if (line.length < 8 || line.length > 150) return true;
  if (!/\s/.test(line)) return true;
  if (isLikelyShellCommand(line)) return true;
  if (isLaunchCommand(line)) return true;
  if (/^[./~]/.test(line) || /^https?:\/\//.test(line)) return true;
  return false;
}

export function deriveTopicFromSubmittedInput(raw: string): string | null {
  const line = normalizeTopicLine(raw);
  if (isIgnorableTopicInput(line)) {
    return null;
  }
  return line.slice(0, 60);
}

export function extractTopicFromTerminalText(plainText: string): string | null {
  const rawLines = plainText.split(/[\r\n]+/);
  const lines = rawLines.map(normalizeTopicLine).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    const promptMatch = raw.match(/^[â€º>]\s*(.+)$/);
    if (!promptMatch) continue;

    const topic = deriveTopicFromSubmittedInput(promptMatch[1]);
    if (topic) {
      return topic;
    }
  }

  const candidates: { line: string; score: number }[] = [];

  for (const raw of lines) {
    let line = raw;
    if (/^[â€º>]\s*/.test(line)) {
      line = line.replace(/^[â€º>]\s*/, '').trim();
    }

    if (isIgnorableTopicInput(line)) continue;

    const wordChars = (line.match(/[a-zA-Z ]/g) ?? []).length;
    if (wordChars / line.length < 0.55) continue;
    if (/^[\$%#!]/.test(line)) continue;
    if (/^[^@\s]+@[^:\s]+:/.test(line)) continue;
    if (/^(Ran|Done!?|Next:|Building |Restarting |Worked for )/i.test(line)) continue;
    if (/^\+?\d+\s+more\s+(lines|tool uses)\b/i.test(line)) continue;
    if (/^\(?ctrl\+|^esc to /i.test(line)) continue;
    if (/^[a-z]/.test(line) && line.length < 28) continue;
    if (/^[0-9]+\.\s/.test(line)) continue;

    let score = 0;
    if (/[a-z]/.test(line[0] || '')) score += 2;
    if (/\b(fix|debug|investigate|add|update|rebuild|test|review|show|explain)\b/i.test(line)) score += 3;
    if (line.length >= 20 && line.length <= 80) score += 2;
    if (!/[.:]\s*$/.test(line)) score += 1;

    candidates.push({ line, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].line.slice(0, 60);
}
