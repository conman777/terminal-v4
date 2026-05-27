function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CODEX_MODEL_RE = /\bgpt-5(?:\.\d+)?\b/i;
const CODEX_EFFORT_RE = /\b(xhigh|high|medium|low)\b/i;

function looksLikeSourceCodeLine(line) {
  return /\b(?:const|let|var|function|return|export|import|if)\b/.test(line)
    || /(?:=>|\.match\(|\.test\(|\/\*|\*\/)/.test(line);
}

function parseClaudeRuntimeInfo(lines) {
  const statusLine = lines.find((line) => (
    /\bCtx:\s*\d+%/i.test(line)
    || /\bClaude Max\b/i.test(line)
    || /\bOpus 4\.6\b/i.test(line)
    || /\bSonnet 4\.6\b/i.test(line)
  ));
  if (!statusLine) return null;

  const modelMatch = statusLine.match(/\b(Opus 4\.6|Sonnet 4\.6)(?:\s+with\s+[^|]+)?/i);
  const ctxMatch = statusLine.match(/Ctx:\s*(\d+%)/i);
  const tierMatch = statusLine.match(/\bClaude Max\b/i);

  return {
    providerId: 'claude',
    label: [modelMatch?.[0], ctxMatch ? `Ctx ${ctxMatch[1]}` : null, tierMatch?.[0]].filter(Boolean).join(' | ')
  };
}

function parseCodexRuntimeInfo(lines) {
  const statusLine = lines.find((line) => (
    !looksLikeSourceCodeLine(line)
    && CODEX_MODEL_RE.test(line)
    && (
      /\b\d+%\s+left\b/i.test(line)
      || CODEX_EFFORT_RE.test(line)
      || /(?:^|\s|·)\s*(?:~[\\/]|\/|[A-Za-z]:[\\/])/.test(line)
    )
  )) || lines.find((line) => !looksLikeSourceCodeLine(line) && /\bmodel:\b/i.test(line) && CODEX_MODEL_RE.test(line));
  if (!statusLine) return null;

  const modelMatch = statusLine.match(/\b(gpt-5(?:\.\d+)?(?:\s+(?:xhigh|high|medium|low))?)/i);
  const leftMatch = statusLine.match(/\b(\d+%\s+left)\b/i);

  return {
    providerId: 'codex',
    label: [modelMatch?.[1], leftMatch?.[1]].filter(Boolean).join(' | ')
  };
}

function parseGeminiRuntimeInfo(lines) {
  const statusLine = lines.find((line) => /\bgemini\b/i.test(line) && (/\bctx\b/i.test(line) || /\bcontext\b/i.test(line) || /\btoken/i.test(line)));
  if (!statusLine) return null;

  return {
    providerId: 'gemini',
    label: statusLine
  };
}

export function parseTerminalRuntimeInfo(snapshot, aiType = null) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) return null;

  const lines = snapshot
    .split('\n')
    .map((line) => compactText(line))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const parsers = new Map([
    ['claude', parseClaudeRuntimeInfo],
    ['codex', parseCodexRuntimeInfo],
    ['gemini', parseGeminiRuntimeInfo],
  ]);

  const orderedProviderIds = [
    aiType,
    'claude',
    'codex',
    'gemini',
  ].filter((providerId, index, values) => typeof providerId === 'string' && values.indexOf(providerId) === index);

  for (const providerId of orderedProviderIds) {
    const parsed = parsers.get(providerId)?.(lines);
    if (parsed) return parsed;
  }

  return null;
}
