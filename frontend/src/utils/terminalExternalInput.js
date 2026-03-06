export const EXTERNAL_INPUT_CHUNK_SIZE = 4;
export const EXTERNAL_INPUT_STEP_DELAY_MS = 8;
export const EXTERNAL_INPUT_SETTLE_DELAY_MS = 120;

export function prepareTerminalForExternalInput({
  requestPriorityResize,
  focusTerminal,
  setMobileInputEnabled,
}) {
  if (typeof requestPriorityResize === 'function') {
    try {
      requestPriorityResize();
    } catch {
      // Ignore transient resize/promotion failures during mount/reconnect.
    }
  }

  if (typeof focusTerminal === 'function') {
    try {
      focusTerminal();
    } catch {
      // Ignore focus failures when the terminal is reconnecting.
    }
  }

  if (typeof setMobileInputEnabled === 'function') {
    setMobileInputEnabled(true);
  }
}

function shouldChunkExternalInput(text) {
  return !(
    typeof text !== 'string'
    || text.length === 0
    || text.startsWith('\x1b')
    || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)
  );
}

export function createExternalInputFrames(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  if (!shouldChunkExternalInput(text)) {
    return [{ data: text, delayAfterMs: 0 }];
  }

  const codepoints = Array.from(text);
  const frames = [];

  for (let index = 0; index < codepoints.length; index += EXTERNAL_INPUT_CHUNK_SIZE) {
    const data = codepoints.slice(index, index + EXTERNAL_INPUT_CHUNK_SIZE).join('');
    const isLast = index + EXTERNAL_INPUT_CHUNK_SIZE >= codepoints.length;
    frames.push({
      data,
      delayAfterMs: isLast ? EXTERNAL_INPUT_SETTLE_DELAY_MS : EXTERNAL_INPUT_STEP_DELAY_MS,
    });
  }

  return frames;
}
