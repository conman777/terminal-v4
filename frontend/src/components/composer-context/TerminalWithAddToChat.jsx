import { LazyTerminalChat } from '../LazyTerminalChat';
import { TerminalAddToChat, useTerminalAddToChat } from './TerminalAddToChat';

export function TerminalWithAddToChat({ owner, label, ...chatProps }) {
  const addToChat = useTerminalAddToChat({ terminalId: chatProps.sessionId, owner, label });
  return <>
    <TerminalAddToChat state={addToChat} />
    <LazyTerminalChat {...chatProps} onRegisterSelectionActions={addToChat.register} />
  </>;
}
