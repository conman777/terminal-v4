import { addTerminalSelectionToDraft } from './terminalSelection';

const readWindowSelection = () => window.getSelection?.()?.toString() || '';

export function TerminalAddToChat({ sessionId, label = 'Terminal', getSelection = readWindowSelection, onAdded, className = 'composer-add-to-chat' }) {
  return (
    <button type="button" className={className} onMouseDown={event => event.preventDefault()}
      onClick={() => { if (addTerminalSelectionToDraft(sessionId, getSelection(), label)) onAdded?.(); }}>
      Add to chat
    </button>
  );
}
