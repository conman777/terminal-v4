export function latestWorkspaceResponse(messages, busy = false) {
  if (busy || !Array.isArray(messages)) return '';
  const last = messages.at(-1);
  return last?.role === 'assistant' && !last.streaming && typeof last.content === 'string'
    ? last.content : '';
}
