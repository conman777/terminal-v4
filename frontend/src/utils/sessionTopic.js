import { COMMON_LAUNCH_PREFIXES } from './aiProviders';

function isLikelyShellCommand(line) {
  return /^(cd|ls|pwd|git|npm|pnpm|yarn|bun|node|python|pip|cargo|go|make|bash|sh|zsh|cat|rg|grep|sed|awk|jq|chmod|chown|mv|cp|rm|mkdir|touch)\b/i.test(line);
}

export function isMeaningfulSessionTopic(topic) {
  if (typeof topic !== 'string') return false;
  const text = topic.trim();
  if (text.length < 8 || text.length > 150) return false;
  if (!/\s/.test(text)) return false;
  if (/^\/[a-z0-9._:-]+(?:\s|$)/i.test(text)) return false;
  if (/^[a-z]:[\\/]/i.test(text)) return false;
  if (/^[./~]/.test(text) || /^https?:\/\//.test(text)) return false;
  if (isLikelyShellCommand(text)) return false;
  if (/\s--?[a-z0-9][\w-]*/i.test(text)) return false;

  const [firstToken = ''] = text.toLowerCase().split(/\s+/, 1);
  if (COMMON_LAUNCH_PREFIXES.includes(firstToken)) return false;

  return true;
}

export function getPreferredSessionTopic(topic, fallbackTitle = 'New session') {
  if (isMeaningfulSessionTopic(topic)) {
    return topic.trim();
  }
  return fallbackTitle || 'New session';
}
