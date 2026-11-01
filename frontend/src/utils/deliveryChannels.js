const URL_LIMIT = 2048;
const SECRET_MIN = 16;
const SECRET_MAX = 256;
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];
const INVALID_URL = 'Enter a valid webhook URL';
const PRIVATE_URL = 'The webhook URL points at a private or local address';

export const DELIVERY_CHANNELS = [
  { id: 'slack', label: 'Slack', urlLabel: 'Slack webhook URL', placeholder: 'https://hooks.slack.com/services/...' },
  { id: 'discord', label: 'Discord', urlLabel: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/...' },
  { id: 'webhook', label: 'Webhook', urlLabel: 'Webhook URL', placeholder: 'https://example.com/hook', secretLabel: 'Webhook signing secret' },
];

function blockedIpv4(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function privateHost(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name.includes(':')) return true;
  const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(name);
  return blockedIpv4(name) || name === 'localhost' || /\.(localhost|local|internal|lan)$/.test(name) || (!isIpv4 && !name.includes('.'));
}

export function validateDeliveryEndpoint(channel, rawUrl, rawSecret = '') {
  const raw = (rawUrl || '').trim();
  if (!raw || raw.length > URL_LIMIT || /[\s\u0000-\u001f\u007f]/.test(raw)) return INVALID_URL;
  let url;
  try { url = new URL(raw); } catch { return INVALID_URL; }
  if (url.username || url.password || url.hash || raw.includes('#')) return 'The webhook URL must not contain credentials or a fragment';
  if (!url.hostname) return INVALID_URL;
  if (url.protocol !== 'https:') return 'The webhook URL must use https';
  if (privateHost(url.hostname)) return PRIVATE_URL;
  const host = url.hostname.toLowerCase();
  if (channel === 'slack' && (host !== 'hooks.slack.com' || !url.pathname.startsWith('/services/'))) return 'Use a Slack incoming webhook URL (hooks.slack.com/services/...)';
  if (channel === 'discord' && (!DISCORD_HOSTS.includes(host) || !url.pathname.startsWith('/api/webhooks/'))) return 'Use a Discord webhook URL (discord.com/api/webhooks/...)';
  if (channel === 'webhook') {
    const bytes = new TextEncoder().encode((rawSecret || '').trim()).length;
    if (bytes < SECRET_MIN || bytes > SECRET_MAX) return 'A signing secret of 16 to 256 characters is required';
  }
  return '';
}
