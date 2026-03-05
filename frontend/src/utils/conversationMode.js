const ANSI_SEQUENCE_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const INTERACTIVE_ANSI_RE = /(?:\x1b\[\?1049[hl]|\x1b\[\?25[hl]|\x1b\[2J|\x1b\[[0-9]+;[0-9]+H)/;

function squashWhitespace(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}

/**
 * Heuristic: detect full-screen interactive CLI output (e.g. Claude startup
 * trust/safety prompts) that does not render well in conversation bubbles.
 */
export function shouldFallbackToTerminalView(outputChunk) {
  if (typeof outputChunk !== 'string' || outputChunk.length === 0) {
    return false;
  }

  if (INTERACTIVE_ANSI_RE.test(outputChunk)) {
    return true;
  }

  const plain = outputChunk.replace(ANSI_SEQUENCE_RE, '').replace(/\r/g, '\n');
  const squashed = squashWhitespace(plain);

  const hasSafetyPrompt =
    (squashed.includes('accessingworkspace:') || squashed.includes('quicksafetycheck')) &&
    (squashed.includes('trustthisfolder') || squashed.includes('esctocancel') || squashed.includes('entertoconfirm'));

  if (hasSafetyPrompt) {
    return true;
  }

  const hasInteractiveChoices =
    squashed.includes('presstochoose') ||
    squashed.includes('entertoconfirm') ||
    squashed.includes('esctocancel');

  if (hasInteractiveChoices && squashed.includes('trustthisfolder')) {
    return true;
  }

  const hasGenericMenuPrompt =
    (
      squashed.includes('selectanoption')
      || squashed.includes('arrowkeystonavigate')
      || squashed.includes('shift+tabtocycle')
      || squashed.includes('presstochoose')
    )
    && (
      squashed.includes('entertocontinue')
      || squashed.includes('entertoconfirm')
      || squashed.includes('esctocancel')
      || squashed.includes('qtoquit')
    );

  if (hasGenericMenuPrompt) {
    return true;
  }

  const hasProgressPrompt =
    /(thinking|computing|running|loading|initializing)/i.test(plain)
    && plain.includes('>')
    && /[•·*]/.test(plain);

  if (hasProgressPrompt) {
    return true;
  }

  return false;
}
