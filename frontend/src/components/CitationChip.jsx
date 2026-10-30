import { projectRelativePath } from '../utils/conversationCitations';
import { useConversationLinks } from '../contexts/ConversationLinksContext';

function Unavailable({ label, reason }) {
  return <span className="md-citation md-citation-unavailable" title={reason}>{label}</span>;
}

export function CitationChip({ target, label, title }) {
  const links = useConversationLinks();
  if (target.kind === 'url') {
    let host = '';
    try { host = new URL(target.href).hostname; } catch { host = ''; }
    return <a className="md-citation" href={target.href} target="_blank" rel="noopener noreferrer" title={title || target.href}
      aria-label={`Source ${label}${title ? `: ${title}` : ''}${host ? ` (${host}, opens in a new tab)` : ''}`}>{label}</a>;
  }
  if (target.kind === 'file') {
    const relative = links?.openFile ? projectRelativePath(target.path, links.root) : null;
    const text = label || `${target.path}${target.line ? `:${target.line}` : ''}`;
    if (!relative) return <Unavailable label={text} reason="Cannot open this file from here" />;
    return <button type="button" className="md-citation md-citation-file" title={`Open ${relative}${target.line ? ` at line ${target.line}` : ''} in Files`}
      aria-label={`Open ${relative}${target.line ? ` at line ${target.line}` : ''} in Files`}
      onClick={() => links.openFile(relative, target.line)}>{text}</button>;
  }
  if (target.kind === 'thread') {
    if (!links?.openThread || links.hasThread?.(target.id) === false) return <Unavailable label={label} reason="This thread is not available" />;
    return <button type="button" className="md-citation md-citation-thread" title="Open thread" aria-label={`Open thread: ${label}`}
      onClick={() => links.openThread(target.id)}>{label}</button>;
  }
  return <Unavailable label={label} reason="Source unavailable" />;
}
