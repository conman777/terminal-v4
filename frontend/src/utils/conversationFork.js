import { stripPlanMarker } from './planMode';

const LIMIT = 20000;

// A first message for a new thread that continues this conversation up to (and including) one reply.
export function forkPrompt(messages, messageId, limit = LIMIT) {
  const lines = [];
  for (const message of messages) {
    if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim()) {
      lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${stripPlanMarker(message.content).trim()}`);
    }
    if (message.messageId === messageId) break;
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > limit) transcript = `…${transcript.slice(-limit)}`;
  return `Continue from this earlier conversation:\n\n${transcript}\n\nPick up from here.`;
}
