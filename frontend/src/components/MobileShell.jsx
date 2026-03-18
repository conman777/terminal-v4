import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalChat } from './TerminalChat';
import { DesktopConversationView } from './DesktopConversationView';
import { DesktopStatusBar } from './DesktopStatusBar';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { useStructuredSession } from '../hooks/useStructuredSession';
import { getAiInitialCommand, getAiTypeOptions } from '../utils/aiProviders';
import { getPreferredSessionTopic } from '../utils/sessionTopic';
import { parseTerminalRuntimeInfo } from '../utils/terminalRuntimeInfo';
import { useTerminalSession } from '../contexts/TerminalSessionContext';

function getSessionLabel(session) {
  if (!session) return 'New session';
  return getPreferredSessionTopic(session.thread?.topic, session.title || 'New session');
}

function getPathLabel(path) {
  if (!path || typeof path !== 'string') return 'No workspace selected';
  return path;
}

export function MobileShell({
  sessions = [],
  activeSessionId = null,
  onSelectSession,
  onCreateSession,
  projectInfo,
  sessionActivity = {},
  onSessionBusyChange,
  fontSize = 14,
  webglEnabled,
  onUrlDetected,
  viewportHeight,
  onViewChange,
  onChatModeChange,
  accessoryOpen = false,
  onAccessoryToggle,
  onAccessoryHeightChange,
  onRegisterFocusTerminal,
  sessionAiTypes = {},
  customAiProviders = [],
  onSetSessionAiType,
  onAddCustomAiProvider,
  showSessionStrip = true,
}) {
  const [connectionState, setConnectionState] = useState('connecting');
  const [currentCwd, setCurrentCwd] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [composerValue, setComposerValue] = useState('');
  const [composerAttachments, setComposerAttachments] = useState([]);
  const [terminalScreenSnapshot, setTerminalScreenSnapshot] = useState('');
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false);
  const [gitBranchInfo, setGitBranchInfo] = useState(null);
  const [isLoadingGitBranches, setIsLoadingGitBranches] = useState(false);
  const [isSwitchingGitBranch, setIsSwitchingGitBranch] = useState(false);
  const [transportNotice, setTransportNotice] = useState('');
  const imageInputRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);
  const { listSessionGitBranches, checkoutSessionGitBranch } = useTerminalSession();

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || sessions[0] || null,
    [activeSessionId, sessions]
  );
  const isStructuredSession = Boolean(currentSession?.id?.startsWith('ss-'));
  const useTerminalFirstLayout = !isStructuredSession;
  const currentAiType = currentSession ? (sessionAiTypes[currentSession.id] ?? null) : null;
  const aiOptions = useMemo(
    () => getAiTypeOptions(customAiProviders),
    [customAiProviders]
  );
  const launchCommand = useMemo(
    () => getAiInitialCommand(currentAiType, customAiProviders),
    [currentAiType, customAiProviders]
  );
  const runtimeInfo = useMemo(
    () => parseTerminalRuntimeInfo(terminalScreenSnapshot, currentAiType),
    [currentAiType, terminalScreenSnapshot]
  );

  const {
    turns,
    isLoading: isConversationHistoryLoading,
    isSendReady,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleRawSend,
    handleInterrupt,
  } = useMobileChatTurns({
    sessionId: currentSession?.id ?? null,
    chatMode: Boolean(currentSession?.id) && !isStructuredSession,
  });

  const {
    messages: structuredMessages,
    currentToolCalls: structuredToolCalls,
    pendingApproval,
    isStreaming: structuredIsStreaming,
    connectionState: structuredConnectionState,
    sendMessage: structuredSendMessage,
    interrupt: structuredInterrupt,
    approve: structuredApprove,
  } = useStructuredSession({
    sessionId: isStructuredSession ? currentSession?.id ?? null : null,
    active: isStructuredSession,
  });

  useEffect(() => {
    onViewChange?.('terminal');
    onChatModeChange?.(false);
    onAccessoryHeightChange?.(0);
  }, [onAccessoryHeightChange, onChatModeChange, onViewChange]);

  useEffect(() => {
    setConnectionState('connecting');
    setCurrentCwd(null);
    setComposerValue('');
    setComposerAttachments([]);
    setTerminalScreenSnapshot('');
    setIsTerminalPanelOpen(false);
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
    setTransportNotice('');
    hasConnectedOnceRef.current = false;
  }, [currentSession?.id]);

  useEffect(() => {
    if (!currentSession?.id) return undefined;

    let cancelled = false;
    setIsLoadingGitBranches(true);

    listSessionGitBranches(currentSession.id)
      .then((data) => {
        if (!cancelled) {
          setGitBranchInfo(data);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingGitBranches(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentSession?.id, listSessionGitBranches, projectInfo?.gitBranch]);

  const handleSelectGitBranch = useCallback(async (nextBranch) => {
    if (!currentSession?.id || !nextBranch || nextBranch === gitBranchInfo?.currentBranch) return;
    setIsSwitchingGitBranch(true);
    try {
      const result = await checkoutSessionGitBranch(currentSession.id, nextBranch);
      if (result) {
        setGitBranchInfo(result);
      }
    } finally {
      setIsSwitchingGitBranch(false);
    }
  }, [checkoutSessionGitBranch, currentSession?.id, gitBranchInfo?.currentBranch]);

  const handleConnectionChange = useCallback((connected) => {
    if (connected) {
      hasConnectedOnceRef.current = true;
      setConnectionState('online');
      return;
    }
    setConnectionState(hasConnectedOnceRef.current ? 'offline' : 'connecting');
  }, []);

  const handleActivityChange = useCallback((isBusy) => {
    if (!currentSession?.id) return;
    onSessionBusyChange?.(currentSession.id, isBusy);
  }, [currentSession?.id, onSessionBusyChange]);

  const handleScreenSnapshot = useCallback((snapshot) => {
    const next = typeof snapshot?.text === 'string' ? snapshot.text : '';
    setTerminalScreenSnapshot((previous) => (previous === next ? previous : next));
  }, []);

  const handleImageUpload = useCallback(() => {
    imageInputRef.current?.click?.();
  }, []);

  const handleToggleTerminalPanel = useCallback(() => {
    setIsTerminalPanelOpen((isOpen) => !isOpen);
  }, []);

  const handleOpenTerminalPanel = useCallback(() => {
    setIsTerminalPanelOpen(true);
  }, []);

  const handleComposerSubmit = useCallback((text) => {
    if (!currentSession?.id) return;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const attachmentPaths = composerAttachments
      .map((attachment) => attachment?.path)
      .filter((path) => typeof path === 'string' && path.trim());
    if (!trimmed && attachmentPaths.length === 0) return;

    const payload = [attachmentPaths.join(' '), trimmed].filter(Boolean).join(' ').trim();
    if (!payload) return;

    const result = handleChatSend(payload);
    setComposerValue('');
    setComposerAttachments([]);
    setTransportNotice(result?.queued ? 'Terminal is still connecting. Command queued.' : '');
  }, [composerAttachments, currentSession?.id, handleChatSend]);

  const handleComposerAttachmentAdd = useCallback((attachment) => {
    if (!attachment?.path) return;
    setComposerAttachments((current) => {
      if (current.some((item) => item.path === attachment.path)) return current;
      return [...current, attachment];
    });
  }, []);

  const handleComposerAttachmentRemove = useCallback((pathToRemove) => {
    setComposerAttachments((current) => current.filter((attachment) => attachment.path !== pathToRemove));
  }, []);

  const launchAiType = useCallback((aiTypeToLaunch, commandOverride = null) => {
    const nextLaunchCommand = commandOverride || getAiInitialCommand(aiTypeToLaunch, customAiProviders);
    if (!nextLaunchCommand) return;
    const result = handleChatSend(nextLaunchCommand);
    setTransportNotice(result?.queued ? 'Terminal is still connecting. Launch command queued.' : '');
  }, [customAiProviders, handleChatSend]);

  const handleSelectAiType = useCallback((nextAiType) => {
    if (!currentSession?.id) return;
    onSetSessionAiType?.(currentSession.id, nextAiType);
    if (nextAiType) {
      launchAiType(nextAiType);
    }
  }, [currentSession?.id, launchAiType, onSetSessionAiType]);

  const handleAddCustomAiCommand = useCallback((label, command) => {
    if (!currentSession?.id) return;
    const provider = onAddCustomAiProvider?.(label, command);
    if (!provider?.id) return;
    onSetSessionAiType?.(currentSession.id, provider.id);
    launchAiType(provider.id, provider.initialCommand);
  }, [currentSession?.id, launchAiType, onAddCustomAiProvider, onSetSessionAiType]);

  return (
    <div className="mobile-shell mobile-shell-parity">
      {showSessionStrip && sessions.length > 1 ? (
        <div className="mobile-shell-session-strip" role="tablist" aria-label="Sessions">
          {sessions.map((session) => {
            const isActive = session.id === currentSession?.id;
            const sessionState = sessionActivity[session.id];
            const statusLabel = sessionState?.isBusy ? 'Running' : sessionState?.hasUnread ? 'Updated' : 'Ready';

            return (
              <button
                key={session.id}
                type="button"
                role="tab"
                aria-selected={isActive ? 'true' : 'false'}
                className={`mobile-shell-session-card${isActive ? ' active' : ''}`}
                onClick={() => onSelectSession?.(session.id)}
              >
                <span className="mobile-shell-session-title">{getSessionLabel(session)}</span>
                <span className="mobile-shell-session-meta">{getPathLabel(session.thread?.projectPath || session.cwd)}</span>
                <span className="mobile-shell-session-status">{statusLabel}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <section className={`mobile-shell-stage mobile-shell-stage-parity${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
        {currentSession ? (
          <div className={`terminal-with-status mobile-terminal-shell${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
            <div className={`desktop-terminal-stack mobile-terminal-stack${isTerminalPanelOpen ? ' terminal-panel-open' : ''}${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
              {!useTerminalFirstLayout ? (
                <div className="desktop-conversation-surface mobile-conversation-surface">
                  <DesktopConversationView
                    turns={turns}
                    isStreaming={structuredIsStreaming}
                    isLoadingHistory={isConversationHistoryLoading}
                    onSend={structuredSendMessage}
                    onSendRaw={handleRawSend}
                    onInterrupt={structuredInterrupt}
                    onImageUpload={handleImageUpload}
                    sessionId={currentSession.id}
                    aiType={currentAiType}
                    connectionState={structuredConnectionState}
                    isSendReady={structuredConnectionState === 'online'}
                    terminalPreview=""
                    terminalScreenSnapshot={terminalScreenSnapshot}
                    launchCommand=""
                    launchQueued={false}
                    onLaunchAgent={undefined}
                    onOpenTerminal={handleOpenTerminalPanel}
                    conversationNotice=""
                    showTerminalMirror={false}
                    interactivePromptEvent={null}
                    mode="structured"
                    structuredMessages={structuredMessages}
                    structuredToolCalls={structuredToolCalls}
                    pendingApproval={pendingApproval}
                    onApprove={structuredApprove}
                  />
                </div>
              ) : null}

              <div
                className={`desktop-terminal-runtime mobile-terminal-runtime${useTerminalFirstLayout || isTerminalPanelOpen ? ' inline-panel-open' : ' is-hidden'}${useTerminalFirstLayout ? ' terminal-first' : ''}`}
                aria-hidden={!useTerminalFirstLayout && !isTerminalPanelOpen ? 'true' : undefined}
              >
                <TerminalChat
                  key={`${currentSession.id}-${refreshToken}`}
                  surface="mobile"
                  sessionId={currentSession.id}
                  keybarOpen={accessoryOpen}
                  viewportHeight={viewportHeight}
                  onUrlDetected={onUrlDetected}
                  fontSize={fontSize}
                  webglEnabled={webglEnabled}
                  inputEnabled={useTerminalFirstLayout || isTerminalPanelOpen}
                  usesTmux={currentSession?.usesTmux}
                  onRegisterImageUpload={(trigger) => {
                    imageInputRef.current = { click: trigger };
                  }}
                  onRegisterFocusTerminal={onRegisterFocusTerminal}
                  onConnectionChange={handleConnectionChange}
                  onCwdChange={setCurrentCwd}
                  onActivityChange={handleActivityChange}
                  onScreenSnapshot={handleScreenSnapshot}
                  onRegisterSendText={handleRegisterSendText}
                  onTurn={handleTurn}
                />
              </div>

              <DesktopStatusBar
                sessionId={currentSession.id}
                sessionTitle={currentSession.title}
                sessionSummary={currentSession.thread?.topic || currentSession.title || ''}
                cwd={currentCwd || projectInfo?.cwd || currentSession?.cwd || ''}
                gitBranch={projectInfo?.gitBranch}
                isActive
                isTerminalPanelOpen={isTerminalPanelOpen}
                showTerminalToggle={!useTerminalFirstLayout}
                onToggleTerminalPanel={!useTerminalFirstLayout ? handleToggleTerminalPanel : undefined}
                connectionState={connectionState}
                aiType={currentAiType}
                aiOptions={aiOptions}
                onSelectAiType={handleSelectAiType}
                onAddCustomAiCommand={handleAddCustomAiCommand}
                composerValue={composerValue}
                composerAttachments={composerAttachments}
                onComposerChange={setComposerValue}
                onComposerSubmit={handleComposerSubmit}
                onComposerAttachmentAdd={handleComposerAttachmentAdd}
                onComposerAttachmentRemove={handleComposerAttachmentRemove}
                composerPlaceholder="Ask V4 anything"
                composerDisabled={!currentSession.id}
                runtimeInfo={runtimeInfo}
                gitBranches={gitBranchInfo?.branches || []}
                currentGitBranch={gitBranchInfo?.currentBranch || projectInfo?.gitBranch || null}
                isLoadingGitBranches={isLoadingGitBranches}
                isSwitchingGitBranch={isSwitchingGitBranch}
                onSelectGitBranch={handleSelectGitBranch}
              />
            </div>
          </div>
        ) : (
          <div className="mobile-shell-empty-state">
            <p className="mobile-shell-empty-kicker">Workspace</p>
            <h2>Create a session to start working.</h2>
            <p>The mobile shell now stays focused on the same terminal and composer flow as desktop.</p>
            <button type="button" className="mobile-shell-primary-button" onClick={() => onCreateSession?.()}>
              Create session
            </button>
          </div>
        )}
      </section>

      {transportNotice ? (
        <div className="mobile-shell-launch-notice" role="status" aria-live="polite">
          {transportNotice}
        </div>
      ) : null}
    </div>
  );
}
