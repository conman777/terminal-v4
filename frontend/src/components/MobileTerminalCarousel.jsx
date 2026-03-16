import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalChat } from './TerminalChat';
import { MobileStatusBar } from './MobileStatusBar';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { MobileChatView } from './MobileChatView';
import { ContextMenu } from './ContextMenu';
import { useLongPress } from '../hooks/useLongPress';
import { getAiInitialCommand } from '../utils/aiProviders';
import { parseTerminalRuntimeInfo } from '../utils/terminalRuntimeInfo';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

export function MobileTerminalCarousel({
  sessions,
  currentIndex,
  onIndexChange,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  onScrollDirection,
  onViewportStateChange,
  onRegisterFocusTerminal,
  onSessionBusyChange,
  sessionAiTypes,
  customAiProviders = [],
  onSetSessionAiType,
  onAddCustomAiProvider,
  chatMode = false,
  onChatModeChange,
}) {
  // Clamp index to valid range when sessions change
  useEffect(() => {
    if (sessions.length === 0) return;
    if (currentIndex < 0) {
      onIndexChange(0);
    } else if (currentIndex >= sessions.length) {
      onIndexChange(sessions.length - 1);
    }
  }, [sessions.length, currentIndex, onIndexChange]);

  const [refreshToken, setRefreshToken] = useState(0);
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);
  const [triggerHistoryPanel, setTriggerHistoryPanel] = useState(null);
  const [triggerScrollToBottom, setTriggerScrollToBottom] = useState(null);
  const [isTerminalScrolledUp, setIsTerminalScrolledUp] = useState(false);
  const [isClaudeBusy, setIsClaudeBusy] = useState(false);
  const [selectionActions, setSelectionActions] = useState(null);
  const [terminalPreview, setTerminalPreview] = useState('');
  const [terminalScreenSnapshot, setTerminalScreenSnapshot] = useState('');
  const [gitBranchInfo, setGitBranchInfo] = useState(null);
  const [isLoadingGitBranches, setIsLoadingGitBranches] = useState(false);
  const [isSwitchingGitBranch, setIsSwitchingGitBranch] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    try {
      const stored = localStorage.getItem('mobileTerminalViewMode');
      return stored === 'reader' ? 'reader' : 'terminal';
    } catch {
      return 'terminal';
    }
  });
  const [connectionState, setConnectionState] = useState('connecting');
  const [reconnectBannerState, setReconnectBannerState] = useState('idle');
  const [terminalContextMenu, setTerminalContextMenu] = useState(null);
  const [windowActive, setWindowActive] = useState(() => isWindowActive());

  const currentSession = sessions[currentIndex] || null;
  const currentAiType = currentSession ? sessionAiTypes?.[currentSession.id] : null;
  const runtimeInfo = parseTerminalRuntimeInfo(terminalScreenSnapshot || terminalPreview, currentAiType);
  const { listSessionGitBranches, checkoutSessionGitBranch } = useTerminalSession();

  // Auto-remount watchdog: if disconnected for 5 continuous minutes, force remount
  const disconnectStartRef = useRef(null);
  const autoRemountTimerRef = useRef(null);
  const reconnectFeedbackTimerRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => subscribeWindowActivity(setWindowActive), []);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(v => v === 'terminal' ? 'reader' : 'terminal');
  }, []);

  const handleRegisterImageUpload = useCallback((trigger) => {
    setTriggerImageUpload(() => trigger);
  }, []);

  const handleRegisterHistoryPanel = useCallback((trigger) => {
    setTriggerHistoryPanel(() => trigger);
  }, []);

  const handleRegisterScrollToBottom = useCallback((trigger) => {
    setTriggerScrollToBottom(() => trigger);
  }, []);

  const handleTerminalViewportStateChange = useCallback((atBottom) => {
    if (chatMode) return;
    setIsTerminalScrolledUp(!atBottom);
    onViewportStateChange?.(atBottom);
  }, [chatMode, onViewportStateChange]);

  const handleChatViewportStateChange = useCallback((atBottom) => {
    if (!chatMode) return;
    onViewportStateChange?.(atBottom);
  }, [chatMode, onViewportStateChange]);

  const handleScrollDirection = useCallback((direction) => {
    onScrollDirection?.(direction);
  }, [onScrollDirection]);

  const handleScrollToBottom = useCallback(() => {
    triggerScrollToBottom?.();
    setIsTerminalScrolledUp(false);
    onViewportStateChange?.(true);
  }, [onViewportStateChange, triggerScrollToBottom]);

  const handleActivityChange = useCallback((isBusy) => {
    setIsClaudeBusy(isBusy);
    onSessionBusyChange?.(currentSession?.id, isBusy);
  }, [onSessionBusyChange, currentSession?.id]);

  const handleRegisterSelectionActions = useCallback((actions) => {
    setSelectionActions(() => actions || null);
  }, []);

  const handleConnectionChange = useCallback((connected) => {
    if (connected) {
      hasConnectedOnceRef.current = true;
      setConnectionState('online');
      disconnectStartRef.current = null;
      if (autoRemountTimerRef.current) {
        clearTimeout(autoRemountTimerRef.current);
        autoRemountTimerRef.current = null;
      }
      setReconnectBannerState((previousState) => {
        if (previousState !== 'reconnecting') {
          return previousState;
        }

        if (reconnectFeedbackTimerRef.current) {
          clearTimeout(reconnectFeedbackTimerRef.current);
          reconnectFeedbackTimerRef.current = null;
        }
        reconnectFeedbackTimerRef.current = setTimeout(() => {
          setReconnectBannerState('idle');
          reconnectFeedbackTimerRef.current = null;
        }, 2000);
        return 'reconnected';
      });
      return;
    }

    setConnectionState(hasConnectedOnceRef.current ? 'offline' : 'connecting');

    if (!hasConnectedOnceRef.current || !windowActive || disconnectStartRef.current) {
      return;
    }

    disconnectStartRef.current = Date.now();
    autoRemountTimerRef.current = setTimeout(() => {
      setReconnectBannerState('reconnecting');
      setRefreshToken(v => v + 1);
      disconnectStartRef.current = null;
      autoRemountTimerRef.current = null;
    }, 5 * 60 * 1000);
  }, [windowActive]);

  useEffect(() => {
    if (windowActive) {
      return;
    }
    disconnectStartRef.current = null;
    if (autoRemountTimerRef.current) {
      clearTimeout(autoRemountTimerRef.current);
      autoRemountTimerRef.current = null;
    }
    setReconnectBannerState('idle');
  }, [windowActive]);

  useEffect(() => {
    hasConnectedOnceRef.current = false;
    setConnectionState('connecting');
    setReconnectBannerState('idle');
    disconnectStartRef.current = null;
    if (autoRemountTimerRef.current) {
      clearTimeout(autoRemountTimerRef.current);
      autoRemountTimerRef.current = null;
    }
    if (reconnectFeedbackTimerRef.current) {
      clearTimeout(reconnectFeedbackTimerRef.current);
      reconnectFeedbackTimerRef.current = null;
    }
  }, [currentSession?.id]);

  const handleOutputChunk = useCallback((chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    const next = chunk
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\r/g, '\n')
      .replace(/\x08/g, '')
      .replace(/[^\x09\x0a\x20-\x7e]/g, ' ')
      .trim();
    if (!next) return;
    setTerminalPreview((previous) => `${previous}\n${next}`.trim().slice(-4000));
  }, []);

  const handleScreenSnapshot = useCallback((snapshot) => {
    const next = typeof snapshot?.text === 'string' ? snapshot.text : '';
    setTerminalScreenSnapshot(next);
  }, []);

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

  const handleTerminalLongPress = useCallback((coords) => {
    const items = [];
    const hasSelection = Boolean(selectionActions?.hasSelection?.());

    if (hasSelection) {
      items.push({
        label: 'Copy selection',
        onClick: () => selectionActions?.copySelection?.()
      });
    }

    if (triggerHistoryPanel) {
      items.push({
        label: 'Open copy panel',
        onClick: () => triggerHistoryPanel?.()
      });
    }

    items.push({
      label: viewMode === 'reader' ? 'Switch to Terminal' : 'Switch to Reader',
      onClick: () => handleToggleViewMode()
    });

    if (items.length === 0) {
      return;
    }

    setTerminalContextMenu({
      x: coords?.x || 12,
      y: coords?.y || 12,
      items
    });
  }, [handleToggleViewMode, selectionActions, triggerHistoryPanel, viewMode]);

  const longPressHandlers = useLongPress(handleTerminalLongPress);

  // Cleanup watchdog timer on unmount
  useEffect(() => {
    return () => {
      clearTimeout(autoRemountTimerRef.current);
      if (reconnectFeedbackTimerRef.current) {
        clearTimeout(reconnectFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSelectionActions(null);
  }, [currentSession?.id]);

  useEffect(() => {
    setTerminalPreview('');
    setTerminalScreenSnapshot('');
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
  }, [currentSession?.id]);

  useEffect(() => {
    if (!currentSession?.id) return;

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
  }, [currentSession?.id, listSessionGitBranches]);

  useEffect(() => {
    setIsTerminalScrolledUp(false);
    onViewportStateChange?.(true);
  }, [chatMode, currentSession?.id, onViewportStateChange, viewMode]);

  const {
    turns,
    isLoading: isChatHistoryLoading,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleInterrupt,
  } = useMobileChatTurns({
    sessionId: currentSession?.id ?? null,
    chatMode,
  });

  const handleSelectAiType = useCallback((nextAiType) => {
    if (!currentSession?.id) return;
    onSetSessionAiType?.(currentSession.id, nextAiType);
    const launchCommand = getAiInitialCommand(nextAiType, customAiProviders);
    if (launchCommand) {
      handleChatSend(launchCommand);
    }
  }, [currentSession?.id, customAiProviders, handleChatSend, onSetSessionAiType]);

  const handleAddCustomAiCommand = useCallback((label, command) => {
    const provider = onAddCustomAiProvider?.(label, command);
    if (!provider?.id || !currentSession?.id) return;
    onSetSessionAiType?.(currentSession.id, provider.id);
    if (provider.initialCommand) {
      handleChatSend(provider.initialCommand);
    }
  }, [currentSession?.id, handleChatSend, onAddCustomAiProvider, onSetSessionAiType]);

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {}
  }, [viewMode]);

  if (sessions.length === 0) {
    return (
      <div className="mobile-terminal-carousel">
        <div className="empty-state">
          <h2>Welcome to Terminal</h2>
          <p>Create a new terminal session to get started.</p>
        </div>
      </div>
    );
  }

  if (!currentSession) {
    return <div className="mobile-terminal-carousel" />;
  }

  return (
    <div className={`mobile-terminal-carousel${currentAiType ? ` pane-ai-${currentAiType}` : ''}`}>
      {connectionState === 'offline' && reconnectBannerState !== 'reconnecting' && (
        <div className="mobile-terminal-disconnected-pill" role="status" aria-live="polite">
          Disconnected
        </div>
      )}
      {reconnectBannerState === 'reconnecting' && (
        <div className="mobile-reconnect-banner reconnecting" role="status" aria-live="assertive">
          <span className="mobile-reconnect-spinner" aria-hidden="true" />
          Reconnecting...
        </div>
      )}
      {reconnectBannerState === 'reconnected' && (
        <div className="mobile-reconnect-banner reconnected" role="status" aria-live="polite">
          Reconnected
        </div>
      )}
      {/* Terminal content — always mounted to keep WebSocket alive.
          In chat mode: opacity:0 hides WebGL canvas at compositor level. */}
      <div
        className="carousel-content"
        style={chatMode ? {
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 0,
        } : undefined}
        aria-hidden={chatMode ? 'true' : undefined}
        {...longPressHandlers}
      >
          <TerminalChat
            key={`${currentSession.id}-${refreshToken}`}
            surface="mobile"
            sessionId={currentSession.id}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          webglEnabled={webglEnabled}
          usesTmux={currentSession?.usesTmux}
          viewMode={viewMode}
          onScrollDirection={handleScrollDirection}
          onViewportStateChange={handleTerminalViewportStateChange}
          onRegisterImageUpload={handleRegisterImageUpload}
          onRegisterHistoryPanel={handleRegisterHistoryPanel}
          onRegisterSelectionActions={handleRegisterSelectionActions}
          onRegisterFocusTerminal={onRegisterFocusTerminal}
          onRegisterScrollToBottom={handleRegisterScrollToBottom}
          onConnectionChange={handleConnectionChange}
          onActivityChange={handleActivityChange}
          onRegisterSendText={handleRegisterSendText}
          onTurn={handleTurn}
          onOutputChunk={handleOutputChunk}
          onScreenSnapshot={handleScreenSnapshot}
        />
      </div>

      {/* Chat view — in normal flex flow so iOS keyboard handling works correctly. */}
      {chatMode && (
        <MobileChatView
          turns={turns}
          isStreaming={isClaudeBusy}
          isLoadingHistory={isChatHistoryLoading}
          onSend={handleChatSend}
          onInterrupt={handleInterrupt}
          onImageUpload={triggerImageUpload ?? undefined}
          sessionId={currentSession?.id ?? null}
          onViewportStateChange={handleChatViewportStateChange}
        />
      )}

      {/* Status bar — terminal mode only */}
      {!chatMode && (
        <MobileStatusBar
          sessionId={currentSession.id}
          onOpenHistory={triggerHistoryPanel}
          viewMode={viewMode}
          onToggleViewMode={handleToggleViewMode}
          aiType={currentAiType}
          customAiProviders={customAiProviders}
          onSelectAiType={handleSelectAiType}
          onAddCustomAiCommand={handleAddCustomAiCommand}
          onLaunchAi={() => {
            const launchCommand = getAiInitialCommand(currentAiType, customAiProviders);
            if (launchCommand) {
              handleChatSend(launchCommand);
            }
          }}
          runtimeInfo={runtimeInfo}
          gitBranches={gitBranchInfo?.branches ?? []}
          currentGitBranch={gitBranchInfo?.currentBranch ?? null}
          isLoadingGitBranches={isLoadingGitBranches}
          isSwitchingGitBranch={isSwitchingGitBranch}
          onSelectGitBranch={handleSelectGitBranch}
          onSendMessage={handleChatSend}
        />
      )}

      {/* Scroll-to-bottom button — terminal mode only */}
      {!chatMode && isTerminalScrolledUp && (
        <button
          type="button"
          className="mobile-scroll-bottom-btn"
          onClick={handleScrollToBottom}
          aria-label="Scroll to bottom"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {terminalContextMenu && (
        <ContextMenu
          x={terminalContextMenu.x}
          y={terminalContextMenu.y}
          items={terminalContextMenu.items}
          onClose={() => setTerminalContextMenu(null)}
        />
      )}
    </div>
  );
}
