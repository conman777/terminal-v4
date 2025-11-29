/**
 * Detects localhost/development server URLs from terminal output
 * Matches common dev server patterns like Vite, Next.js, Create React App, etc.
 */

// Common patterns for dev server URLs in terminal output
const URL_PATTERNS = [
  // Standard localhost URLs with port
  /https?:\/\/localhost:\d{2,5}\/?/gi,
  // IP-based local URLs (127.0.0.1, 0.0.0.0)
  /https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\/?/gi,
  // Local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  /https?:\/\/(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{2,5}\/?/gi,
];

// Keywords that indicate a dev server is ready
const SERVER_READY_KEYWORDS = [
  'ready',
  'started',
  'listening',
  'running',
  'server',
  'local:',
  'network:',
  '➜',
  'compiled',
  'built',
];

/**
 * Extract URLs from terminal text
 * @param {string} text - Terminal output text (may contain ANSI codes)
 * @returns {string[]} Array of detected URLs
 */
export function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];

  // Strip ANSI escape codes for cleaner matching
  const cleanText = stripAnsi(text);

  const urls = new Set();

  for (const pattern of URL_PATTERNS) {
    const matches = cleanText.match(pattern);
    if (matches) {
      matches.forEach(url => urls.add(normalizeUrl(url)));
    }
  }

  return Array.from(urls);
}

/**
 * Check if text indicates a dev server is ready
 * @param {string} text - Terminal output text
 * @returns {boolean}
 */
export function isServerReady(text) {
  if (!text || typeof text !== 'string') return false;

  const lowerText = stripAnsi(text).toLowerCase();
  return SERVER_READY_KEYWORDS.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Extract the most likely preview URL from terminal output
 * Prefers localhost URLs over network IPs
 * @param {string} text - Terminal output text
 * @returns {string|null} The best URL to use for preview, or null if none found
 */
export function extractPreviewUrl(text) {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  // Prefer localhost URLs
  const localhostUrl = urls.find(url => url.includes('localhost'));
  if (localhostUrl) return localhostUrl;

  // Then prefer 127.0.0.1
  const loopbackUrl = urls.find(url => url.includes('127.0.0.1'));
  if (loopbackUrl) return loopbackUrl;

  // Fall back to first URL found
  return urls[0];
}

/**
 * Strip ANSI escape codes from text
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Normalize URL (remove trailing slash, ensure proper format)
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash for consistency
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url.replace(/\/$/, '');
  }
}

/**
 * Check if a URL is likely a development server
 * @param {string} url
 * @returns {boolean}
 */
export function isDevServerUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Check if it's a local address
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}
