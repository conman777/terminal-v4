import { TerminalChat } from './TerminalChat';

export default function ClaudeCodePanel({
  sessionId,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  terminalFidelityMode,
  onScrollDirection,
  onRegisterFocusTerminal,
  usesTmux
}) {
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
      <TerminalChat
        sessionId={sessionId}
        keybarOpen={keybarOpen}
        viewportHeight={viewportHeight}
        onUrlDetected={onUrlDetected}
        fontSize={fontSize}
        webglEnabled={webglEnabled}
        terminalFidelityMode={terminalFidelityMode}
        usesTmux={usesTmux}
        onScrollDirection={onScrollDirection}
        onRegisterFocusTerminal={onRegisterFocusTerminal}
      />
    </div>
  );
}
