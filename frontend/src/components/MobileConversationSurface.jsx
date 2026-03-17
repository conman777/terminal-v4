import { useCallback, useState } from 'react';
import { MobileChatView } from './MobileChatView';
import { TerminalChat } from './TerminalChat';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';

export function MobileConversationSurface({
  session,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  onSessionBusyChange,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);
  const handleRegisterImageUpload = useCallback((trigger) => {
    setTriggerImageUpload(() => trigger);
  }, []);

  const {
    turns,
    isLoading: isLoadingHistory,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleInterrupt,
  } = useMobileChatTurns({
    sessionId: session?.id ?? null,
    chatMode: Boolean(session?.id),
  });

  const handleActivityChange = useCallback((isBusy) => {
    setIsStreaming(isBusy);
    onSessionBusyChange?.(session?.id, isBusy);
  }, [onSessionBusyChange, session?.id]);

  if (!session) {
    return (
      <div className="claude-code-panel">
        <div className="claude-code-empty">
          <div className="empty-icon">CC</div>
          <div className="empty-title">Conversation</div>
          <div className="empty-subtitle">Start a session to open the mobile conversation view.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="claude-code-panel">
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 0,
        }}
        aria-hidden="true"
      >
        <TerminalChat
          surface="mobile"
          sessionId={session.id}
          keybarOpen={false}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          webglEnabled={webglEnabled}
          usesTmux={session.usesTmux}
          onScrollDirection={() => {}}
          onViewportStateChange={() => {}}
          onRegisterImageUpload={handleRegisterImageUpload}
          onRegisterSendText={handleRegisterSendText}
          onActivityChange={handleActivityChange}
          onTurn={handleTurn}
        />
      </div>

      <MobileChatView
        turns={turns}
        isStreaming={isStreaming}
        isLoadingHistory={isLoadingHistory}
        onSend={handleChatSend}
        onInterrupt={handleInterrupt}
        onImageUpload={triggerImageUpload ?? undefined}
        sessionId={session.id}
        onViewportStateChange={() => {}}
      />
    </div>
  );
}
