import { isStructuredSessionId } from '../../utils/structuredSessions';

const NO_THREAD = 'Open this terminal from a thread to add its output to that thread’s chat.';
const BLANK = 'The selection is blank.';

const threadTitle = session => session.thread?.topic || session.title || session.id;

export function resolveTerminalOwner({ terminalId, sessions, activeThreadId }) {
  const list = Array.isArray(sessions) ? sessions : [];
  const find = id => (isStructuredSessionId(id) ? list.find(session => session?.id === id) : undefined);
  const terminal = list.find(session => session?.id === terminalId);
  const owner = find(terminalId) || (terminal?.thread?.companionOf ? find(terminal.thread.companionOf) : undefined)
    || (!terminal?.thread?.companionOf ? find(activeThreadId) : undefined);
  return owner ? { threadId: owner.id, title: threadTitle(owner) } : null;
}

export function describeAddToChat({ owner, text }) {
  if (!text) return { visible: false, disabled: true, reason: '' };
  if (!owner) return { visible: true, disabled: true, reason: NO_THREAD };
  if (!text.trim()) return { visible: true, disabled: true, reason: BLANK };
  return { visible: true, disabled: false, reason: '' };
}
