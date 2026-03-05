const ANSI_SEQUENCE_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const INTERACTIVE_ANSI_RE = /(?:\x1b\[\?1049[hl]|\x1b\[\?25[hl]|\x1b\[2J|\x1b\[[0-9]+;[0-9]+H)/;

function squashWhitespace(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}

/**
 * Detect truly interactive terminal states that need raw key passthrough.
 * Keep this strict so normal streaming output remains in conversation mode.
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

  const hasYesNoPrompt =
    /\[[yYnN]\/[yYnN]\]/.test(plain) ||
    (
      (squashed.includes('continueanyway') || squashed.includes('trustthisfolder') || squashed.includes('bypasspermissions')) &&
      (squashed.includes('[y/n]') || squashed.includes('[n/y]'))
    );

  if (hasYesNoPrompt) {
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
      squashed.includes('selectanoption') ||
      squashed.includes('arrowkeystonavigate') ||
      squashed.includes('shift+tabtocycle') ||
      squashed.includes('presstochoose')
    ) &&
    (
      squashed.includes('entertocontinue') ||
      squashed.includes('entertoconfirm') ||
      squashed.includes('esctocancel') ||
      squashed.includes('qtoquit')
    );

  if (hasGenericMenuPrompt) {
    return true;
  }

  return false;
}
