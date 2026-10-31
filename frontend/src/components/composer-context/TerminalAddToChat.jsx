import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { captureAuthScope, isAuthScopeCurrent } from '../../utils/auth';
import { getEnvironmentSignal } from '../../utils/remoteEnvironments';
import { describeAddToChat } from './addToChatState';
import { addTerminalSelectionToDraft } from './terminalSelection';

const readText = actions => {
  try { return actions?.getSelectionText?.() || ''; } catch { return ''; }
};

export function useTerminalAddToChat({ terminalId, owner, label = 'Terminal' }) {
  const [registered, setRegistered] = useState(null);
  const [text, setText] = useState('');
  const [added, setAdded] = useState(null);
  const register = useCallback(actions => setRegistered(actions ? { actions, auth: captureAuthScope(), environment: getEnvironmentSignal() } : null), []);
  const registrationCurrent = () => registered && !registered.environment.aborted && isAuthScopeCurrent(registered.auth);
  const actions = registered?.actions?.sessionId === terminalId && registrationCurrent() ? registered.actions : null;

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
    if (!registered || registered.environment.aborted || !isAuthScopeCurrent(registered.auth)) return false;
    const current = readText(actions);
    if (!ownerId || !addTerminalSelectionToDraft(ownerId, current, label)) return false;
    setAdded({ title: ownerTitle });
    actions.clearSelection?.();
    return true;
  }, [actions, label, ownerId, ownerTitle, registered]);

  const makeMenuItems = useCallback(() => {
    if (!actions?.hasSelection?.()) return [];
    const check = describeAddToChat({ owner: ownerId ? { threadId: ownerId, title: ownerTitle } : null, text: readText(actions) });
    return [
      { label: 'Copy selection', onClick: () => actions.copySelection?.() },
      { label: check.disabled ? `Add to chat (${check.reason.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())})` : `Add to chat: ${ownerTitle}`, disabled: check.disabled, onClick: add },
    ];
  }, [actions, add, ownerId, ownerTitle]);
  const menuItems = useMemo(() => makeMenuItems(), [makeMenuItems, text]);
  const menuItemsAtPoint = useCallback((coords) => {
    if (!registered || registered.environment.aborted || !isAuthScopeCurrent(registered.auth)) return [];
    if (!actions?.hasSelection?.()) actions?.selectLineAtPoint?.(coords);
    return makeMenuItems();
  }, [actions, makeMenuItems, registered]);

  return { ...state, owner, added, register, add, menuItems, menuItemsAtPoint, hasSelection: Boolean(text) };
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
