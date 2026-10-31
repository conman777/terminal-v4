import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { describeAddToChat } from './addToChatState';
import { addTerminalSelectionToDraft } from './terminalSelection';

const readText = actions => {
  try { return actions?.getSelectionText?.() || ''; } catch { return ''; }
};

export function useTerminalAddToChat({ terminalId, owner, label = 'Terminal' }) {
  const [registered, setRegistered] = useState(null);
  const [text, setText] = useState('');
  const [added, setAdded] = useState(null);
  const register = useCallback(actions => setRegistered(actions || null), []);
  const actions = registered && registered.sessionId === terminalId ? registered : null;

  useEffect(() => {
    setText('');
    setAdded(null);
    if (!actions) return undefined;
    const read = () => { const next = readText(actions); setText(next); if (next) setAdded(null); };
    read();
    return actions.subscribe?.(read);
  }, [actions]);

  const state = describeAddToChat({ owner, text });
  const ownerId = owner?.threadId;
  const ownerTitle = owner?.title;

  const add = useCallback(() => {
    const current = readText(actions);
    if (!ownerId || !addTerminalSelectionToDraft(ownerId, current, label)) return false;
    setAdded({ title: ownerTitle });
    actions.clearSelection?.();
    return true;
  }, [actions, label, ownerId, ownerTitle]);

  const getMenuItems = useCallback(() => {
    if (!actions?.hasSelection?.()) return [];
    const check = describeAddToChat({ owner: ownerId ? { threadId: ownerId, title: ownerTitle } : null, text: readText(actions) });
    return [
      { label: 'Copy selection', onClick: () => actions.copySelection?.() },
      { label: check.disabled ? `Add to chat (${check.reason.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())})` : `Add to chat: ${ownerTitle}`, disabled: check.disabled, onClick: add },
    ];
  }, [actions, add, ownerId, ownerTitle]);
  const menuItems = useMemo(() => getMenuItems(), [getMenuItems, text]);

  return { ...state, owner, added, register, add, menuItems, getMenuItems, hasSelection: Boolean(text) };
}

export function TerminalAddToChat({ state, className = 'terminal-add-to-chat' }) {
  const reasonId = useId();
  if (state.added && !state.visible) {
    return <div className={className}><span role="status">{`Added to ${state.added.title}`}</span></div>;
  }
  if (!state.visible) return null;
  return (
    <div className={className}>
      <button type="button" className="composer-add-to-chat" aria-disabled={state.disabled ? 'true' : 'false'}
        aria-describedby={state.disabled ? reasonId : undefined}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (!state.disabled) state.add(); }}>
        {state.owner ? `Add to chat: ${state.owner.title}` : 'Add to chat'}
      </button>
      {state.disabled && <span id={reasonId} className="terminal-add-to-chat-reason">{state.reason}</span>}
    </div>
  );
}
