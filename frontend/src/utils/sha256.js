// WebCrypto is unavailable on ordinary HTTP origins. The fallback computes the
// same digest locally; random IDs still require crypto.getRandomValues.
export async function sha256Bytes(input) {
  if (!(input instanceof Uint8Array) && !(ArrayBuffer.isView(input) && input.constructor?.name === 'Uint8Array')) throw new TypeError('SHA-256 requires bytes.');
  if (globalThis.crypto?.subtle) {
    try { return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input)); }
    catch { /* Fall back if this browser cannot provide SHA-256. */ }
  }
  const { sha256 } = await import('@noble/hashes/sha2');
  return sha256(input);
}

export async function sha256Hex(input) {
  return Array.from(await sha256Bytes(input), byte => byte.toString(16).padStart(2, '0')).join('');
}
