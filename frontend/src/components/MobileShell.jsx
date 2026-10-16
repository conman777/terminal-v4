import { environmentAllows } from '../utils/runtimePermissions';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { resolveAgentLaunchCommand } from '../utils/agentLauncher';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LazyTerminalChat } from './LazyTerminalChat';
import { LazyDesktopConversationView } from './LazyDesktopConversationView';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';
import { latestWorkspaceResponse } from '../utils/workspaceResponse';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';
import { DesktopStatusBar } from './DesktopStatusBar';
import { MobileKeybar } from './MobileKeybar';
import { WorkspaceStartView } from './WorkspaceStartView';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { useStructuredSession } from '../hooks/useStructuredSession';
import { getAiInitialCommand, getAiTypeOptions, inferSessionAiType } from '../utils/aiProviders';
import { getPreferredSessionTopic } from '../utils/sessionTopic';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { parseTerminalRuntimeInfo } from '../utils/terminalRuntimeInfo';
import { useTerminalSession } from '../contexts/TerminalSessionContext';

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function extractTerminalPreviewLines(chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) return [];

  return chunk
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n')
    .replace(/\x08/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);
}

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
  onSelectHistorySession,
  onCreateSession,
  onSubmitPrompt,
  onAddWorkspace,
  projectInfo,
  sessionActivity = {},
  onSessionBusyChange,
  fontSize = 14,
  webglEnabled,
  onUrlDetected,
  viewportHeight,
  accessoryOpen = false,
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
  const [terminalPreview, setTerminalPreview] = useState('');
  const [terminalScreenSnapshot, setTerminalScreenSnapshot] = useState('');
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false);
  const [terminalRuntimeLatched, setTerminalRuntimeLatched] = useState(false);
  const [isTerminalBusy, setIsTerminalBusy] = useState(false);
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
  const isStructuredSession = isStructuredSessionId(currentSession?.id);
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const terminalInputAllowed = environmentAllows(environment, 'terminalInput');
  const agentExecutionAllowed = environmentAllows(environment, 'agentExecute');
  const sessionInputAllowed = isStructuredSession ? agentExecutionAllowed : terminalInputAllowed;
  const inferredAiType = currentSession ? (sessionAiTypes[currentSession.id] ?? inferSessionAiType(currentSession)) : null;
  const aiOptions = useMemo(
    () => getAiTypeOptions(customAiProviders),
    [customAiProviders]
  );
  const runtimeInfo = useMemo(
    () => parseTerminalRuntimeInfo(terminalScreenSnapshot || terminalPreview, inferredAiType),
    [inferredAiType, terminalPreview, terminalScreenSnapshot]
  );
  const currentAiType = inferredAiType ?? runtimeInfo?.providerId ?? null;
  const launchCommand = useMemo(
    () => getAiInitialCommand(currentAiType, customAiProviders),
    [currentAiType, customAiProviders]
  );
  const isTerminalBackedSession = Boolean(currentSession?.id) && !isStructuredSession;
  // Terminal v4 stable: terminal-backed sessions always show the full PTY.
  const useConversationFirstLayout = isStructuredSession;
  const useTerminalFirstLayout = isTerminalBackedSession;
  const isTerminalDockVisible = useTerminalFirstLayout || isTerminalPanelOpen;
  const shouldRenderTerminalRuntime = (
    isTerminalBackedSession
    || isTerminalPanelOpen
    || terminalRuntimeLatched
  );

  useEffect(() => {
    if (isTerminalBackedSession || isTerminalPanelOpen) {
      setTerminalRuntimeLatched(true);
    }
  }, [isTerminalBackedSession, isTerminalPanelOpen]);

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
  const resolvedConnectionState = isStructuredSession ? structuredConnectionState : connectionState;

  useEffect(() => () => {
    onAccessoryHeightChange?.(0);
  }, [onAccessoryHeightChange]);

  useEffect(() => {
    setConnectionState('connecting');
    setCurrentCwd(null);
    setComposerValue('');
    setComposerAttachments([]);
    setTerminalPreview('');
    setTerminalScreenSnapshot('');
    setIsTerminalPanelOpen(false);
    setTerminalRuntimeLatched(false);
    setIsTerminalBusy(false);
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
    setTransportNotice('');
    hasConnectedOnceRef.current = false;
  }, [currentSession?.id]);

  useEffect(() => {
    if (!currentSession?.id) return undefined;
    if (isStructuredSession) {
      setGitBranchInfo(null);
      setIsLoadingGitBranches(false);
      return undefined;
    }

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
  }, [currentSession?.id, isStructuredSession, listSessionGitBranches, projectInfo?.gitBranch]);

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
    setIsTerminalBusy(isBusy);
    if (!currentSession?.id) return;
    onSessionBusyChange?.(currentSession.id, isBusy);
  }, [currentSession?.id, onSessionBusyChange]);

  const handleOutputChunk = useCallback((chunk) => {
    const lines = extractTerminalPreviewLines(chunk);
    if (lines.length === 0) return;

    setTerminalPreview((previous) => {
      const combined = [...(previous ? previous.split('\n') : []), ...lines]
        .slice(-80)
        .join('\n')
        .trim();
      return combined;
    });
  }, []);

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
    if (!currentSession?.id || !environmentAllows(getActiveEnvironment(), isStructuredSession ? 'agentExecute' : 'terminalInput')) return;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const attachmentPaths = composerAttachments
      .map((attachment) => attachment?.path)
      .filter((path) => typeof path === 'string' && path.trim());
    if (!trimmed && attachmentPaths.length === 0) return;

    const payload = [attachmentPaths.join(' '), trimmed].filter(Boolean).join(' ').trim();
    if (!payload) return;

    const result = isStructuredSession ? structuredSendMessage(payload) : handleChatSend(payload);
    setComposerValue('');
    setComposerAttachments([]);
    setTransportNotice(result?.queued ? 'Terminal is still connecting. Command queued.' : '');
  }, [composerAttachments, currentSession?.id, handleChatSend, isStructuredSession, structuredSendMessage]);

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

  const launchAiType = useCallback(async (aiTypeToLaunch, commandOverride = null) => {
    try {
      const nextLaunchCommand = commandOverride || await resolveAgentLaunchCommand(aiTypeToLaunch, null, customAiProviders);
      if (!nextLaunchCommand) return;
      const result = handleChatSend(nextLaunchCommand);
      setTransportNotice(result?.queued ? 'Terminal is still connecting. Launch command queued.' : '');
    } catch (error) { setTransportNotice(error.message || 'Unable to start this agent'); }
  }, [customAiProviders, handleChatSend]);

  const handleLaunchAgent = useCallback(() => {
    if (currentAiType) {
      launchAiType(currentAiType);
    }
  }, [currentAiType, launchAiType]);

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
            <div className={`desktop-terminal-stack mobile-terminal-stack${isTerminalDockVisible ? ' terminal-panel-open' : ''}${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
              {useConversationFirstLayout ? (
                <div className="desktop-conversation-surface mobile-conversation-surface">
                  <LazyDesktopConversationView
                    turns={isStructuredSession ? [] : turns}
                    isStreaming={isStructuredSession ? structuredIsStreaming : isTerminalBusy}
                    isLoadingHistory={!isStructuredSession && isConversationHistoryLoading}
                    onSend={sessionInputAllowed ? (isStructuredSession ? structuredSendMessage : handleChatSend) : undefined}
                    onSendRaw={sessionInputAllowed ? handleRawSend : undefined}
                    onInterrupt={sessionInputAllowed ? (isStructuredSession ? structuredInterrupt : handleInterrupt) : undefined}
                    onImageUpload={handleImageUpload}
                    sessionId={currentSession.id}
                    aiType={currentAiType}
                    connectionState={resolvedConnectionState}
                    isSendReady={isStructuredSession ? structuredConnectionState === 'online' : isSendReady}
                    terminalPreview={terminalPreview}
                    terminalScreenSnapshot={terminalScreenSnapshot}
                    launchCommand={isStructuredSession ? '' : launchCommand}
                    launchQueued={false}
                    onLaunchAgent={!isStructuredSession && terminalInputAllowed && agentExecutionAllowed ? handleLaunchAgent : undefined}
                    onOpenTerminal={isStructuredSession || isTerminalBackedSession ? handleOpenTerminalPanel : undefined}
                    conversationNotice={transportNotice}
                    showTerminalMirror={isTerminalDockVisible}
                    interactivePromptEvent={null}
                    isTerminalDockVisible={isTerminalDockVisible}
                    mode={isStructuredSession ? 'structured' : 'terminal'}
                    structuredMessages={structuredMessages}
                    structuredToolCalls={structuredToolCalls}
                    pendingApproval={pendingApproval}
                    onApprove={agentExecutionAllowed ? structuredApprove : undefined}
                  />
                </div>
              ) : null}

              <div
                className={`desktop-terminal-slot mobile-terminal-slot${isTerminalDockVisible ? ' is-open' : ' is-collapsed'}${useTerminalFirstLayout ? ' terminal-first' : ''}`}
                aria-hidden={!isTerminalDockVisible ? 'true' : undefined}
              >
                <div className="desktop-terminal-runtime-host" data-persistent-terminal="">
                  {shouldRenderTerminalRuntime ? (
                    <LazyTerminalChat
                      key={`${currentSession.id}-${refreshToken}`}
                      surface="mobile"
                      sessionId={currentSession.id}
                      keybarOpen={accessoryOpen}
                      viewportHeight={viewportHeight}
                      onUrlDetected={onUrlDetected}
                      fontSize={fontSize}
                      webglEnabled={webglEnabled}
                      inputEnabled={terminalInputAllowed && (useTerminalFirstLayout || (isStructuredSession && isTerminalPanelOpen))}
                      usesTmux={currentSession?.usesTmux}
                      isPrimary={isTerminalDockVisible}
                      onRegisterImageUpload={(trigger) => {
                        imageInputRef.current = { click: trigger };
                      }}
                      onRegisterFocusTerminal={onRegisterFocusTerminal}
                      onConnectionChange={handleConnectionChange}
                      onCwdChange={setCurrentCwd}
                      onActivityChange={handleActivityChange}
                      onOutputChunk={handleOutputChunk}
                      onScreenSnapshot={handleScreenSnapshot}
                      onRegisterSendText={handleRegisterSendText}
                      onTurn={handleTurn}
                    />
                  ) : null}
                </div>
              </div>

              <DesktopStatusBar
                sessionId={currentSession.id}
                sessionTitle={currentSession.title}
                sessionSummary={currentSession.thread?.topic || currentSession.title || ''}
                cwd={currentCwd || projectInfo?.cwd || currentSession?.cwd || ''}
                gitBranch={projectInfo?.gitBranch}
                isActive
                isTerminalPanelOpen={!useTerminalFirstLayout && isTerminalDockVisible}
                showTerminalToggle={!useTerminalFirstLayout && isStructuredSession}
                onToggleTerminalPanel={!useTerminalFirstLayout && isStructuredSession ? handleToggleTerminalPanel : undefined}
                terminalViewMode="terminal"
                showTerminalViewModeToggle={false}
                onToggleTerminalViewMode={undefined}
                connectionState={resolvedConnectionState}
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
                composerPlaceholder={sessionInputAllowed ? "Ask V4 anything" : "Read-only remote session"}
                composerDisabled={!currentSession.id || !sessionInputAllowed}
                runtimeInfo={runtimeInfo}
                gitBranches={gitBranchInfo?.branches || []}
                currentGitBranch={gitBranchInfo?.currentBranch || projectInfo?.gitBranch || null}
                isLoadingGitBranches={isLoadingGitBranches}
                isSwitchingGitBranch={isSwitchingGitBranch}
                onSelectGitBranch={environmentAllows(environment, 'fileWrite') ? handleSelectGitBranch : undefined}
                composerSecondaryAction={<>
                  <WorkspaceToolsButton
                    workspacePath={currentSession?.thread?.projectPath || currentSession?.cwd || currentCwd || projectInfo?.cwd}
                    currentSessionId={currentSession?.id}
                    latestAssistantText={latestWorkspaceResponse(isStructuredSession ? structuredMessages : turns, isStructuredSession ? structuredIsStreaming : isTerminalBusy)}
                    onStartTask={onCreateSession}
                    onSelectSession={onSelectHistorySession}
                    onInsertPrompt={currentAiType || isStructuredSession ? prompt => setComposerValue(prompt) : undefined}
                  />
                  <WorkspaceProfileButton
                  workspacePath={currentSession?.thread?.projectPath || currentSession?.cwd || currentCwd || projectInfo?.cwd}
                  aiOptions={aiOptions}
                  onInsertContext={currentAiType || isStructuredSession ? context => setComposerValue(value =>
                    context + (value.trim() ? '\n\nTask:\n' + value : '')) : undefined}
                /></>}
              />
            </div>
          </div>
        ) : (
          <WorkspaceStartView
            onSelectHistorySession={onSelectHistorySession}
            currentPath={projectInfo?.cwd || ''}
            onCreateSession={onCreateSession}
            onSubmitPrompt={onSubmitPrompt}
            onAddWorkspace={onAddWorkspace}
          />
        )}
      </section>

      {currentSession?.id && isTerminalDockVisible && terminalInputAllowed ? (
        <MobileKeybar
          sessionId={currentSession.id}
          isOpen={accessoryOpen}
          onHeightChange={onAccessoryHeightChange}
        />
      ) : null}

      {transportNotice ? (
        <div className="mobile-shell-launch-notice" role="status" aria-live="polite">
          {transportNotice}
        </div>
      ) : null}
    </div>
  );
}
