import { useState, useCallback } from 'react';
import { TerminalChat } from './TerminalChat';
import { MobileChatView } from './MobileChatView';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';

export default function ClaudeCodePanel({
  sessionId,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  onScrollDirection,
  onViewportStateChange,
  onRegisterFocusTerminal,
  onSessionBusyChange,
  usesTmux,
  chatMode = false
}) {
  const [isClaudeBusy, setIsClaudeBusy] = useState(false);

  const {
    turns,
    isLoading: isChatHistoryLoading,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleInterrupt,
  } = useMobileChatTurns({ sessionId, chatMode });

  const handleActivityChange = useCallback((isBusy) => {
    setIsClaudeBusy(isBusy);
    onSessionBusyChange?.(sessionId, isBusy);
  }, [onSessionBusyChange, sessionId]);

  const handleTerminalViewportStateChange = useCallback((atBottom) => {
    if (chatMode) return;
    onViewportStateChange?.(atBottom);
  }, [chatMode, onViewportStateChange]);

  const handleChatViewportStateChange = useCallback((atBottom) => {
    if (!chatMode) return;
    onViewportStateChange?.(atBottom);
  }, [chatMode, onViewportStateChange]);

  if (!sessionId) {
    return (
      <div className="claude-code-panel">
        <div className="claude-code-empty">
          <div className="empty-icon">CC</div>
          <div className="empty-title">Claude Code</div>
          <div className="empty-subtitle">Start a session to open the Claude Code CLI.</div>
          <div className="empty-subtitle">Use /model inside the CLI to switch models.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="claude-code-panel">
      {/* Terminal - always mounted. opacity:0 hides WebGL canvas at compositor level. */}
      <div
        style={chatMode ? {
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 0,
        } : { height: '100%' }}
        aria-hidden={chatMode ? 'true' : undefined}
      >
        <TerminalChat
          surface="mobile"
          sessionId={sessionId}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          webglEnabled={webglEnabled}
          usesTmux={usesTmux}
          onScrollDirection={onScrollDirection}
          onViewportStateChange={handleTerminalViewportStateChange}
          onRegisterFocusTerminal={onRegisterFocusTerminal}
          onActivityChange={handleActivityChange}
          onRegisterSendText={handleRegisterSendText}
          onTurn={handleTurn}
        />
      </div>

      {/* Chat view - in normal flow so iOS keyboard handling works correctly */}
      {chatMode && (
        <MobileChatView
          turns={turns}
          isStreaming={isClaudeBusy}
          isLoadingHistory={isChatHistoryLoading}
          onSend={handleChatSend}
          onInterrupt={handleInterrupt}
          sessionId={sessionId}
          onViewportStateChange={handleChatViewportStateChange}
        />
      )}
    </div>
  );
}
