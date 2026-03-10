function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseClaudeRuntimeInfo(lines) {
  const statusLine = lines.find((line) => /\bCtx:\s*\d+%/i.test(line) || /\bClaude Max\b/i.test(line) || /\bOpus 4\.6\b/i.test(line) || /\bSonnet 4\.6\b/i.test(line));
  if (!statusLine) return null;

  const modelMatch = statusLine.match(/\b(Opus 4\.6|Sonnet 4\.6)(?:\s+with\s+[^|Â·]+)?/i);
  const ctxMatch = statusLine.match(/Ctx:\s*(\d+%)/i);
  const tierMatch = statusLine.match(/\bClaude Max\b/i);

  return {
    providerId: 'claude',
    label: [modelMatch?.[0], ctxMatch ? `Ctx ${ctxMatch[1]}` : null, tierMatch?.[0]].filter(Boolean).join(' Â· ')
  };
}

function parseCodexRuntimeInfo(lines) {
  const statusLine = lines.find((line) => /\bgpt-5\.4\b/i.test(line) && /\b\d+%\s+left\b/i.test(line))
    || lines.find((line) => /\bmodel:\b/i.test(line) && /\b\d+%\s+left\b/i.test(line));
  if (!statusLine) return null;

  const modelMatch = statusLine.match(/\b(gpt-5\.4(?:\s+(?!\d+%)[a-z0-9.-]+)*)/i);
  const leftMatch = statusLine.match(/\b(\d+%\s+left)\b/i);

  return {
    providerId: 'codex',
    label: [modelMatch?.[1], leftMatch?.[1]].filter(Boolean).join(' Â· ')
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
