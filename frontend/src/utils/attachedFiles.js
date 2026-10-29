// Agent conversations receive attachments as file paths their tools can open.
export function withAttachedFiles(text, paths) {
  const message = (text || '').trim();
  if (!paths.length) return message;
  const list = `Attached files:\n${paths.map(path => `- ${path}`).join('\n')}`;
  return message ? `${message}\n\n${list}` : list;
}
