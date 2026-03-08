const CONTROL_RESPONSE_RE =
  /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b\[(?:\?|>)?[\d;]*[cnR]|\x1b\[[IO])/g;

export function isTerminalControlResponseInput(input) {
  if (!input) return false;
  if (!String(input).includes('\x1b')) return false;
  const remainder = String(input).replace(CONTROL_RESPONSE_RE, '').trim();
  return remainder.length === 0;
}
