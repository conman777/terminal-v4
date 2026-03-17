import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from './ContextMenu';
import { MobileStatusBar } from './MobileStatusBar';
import { TerminalChat } from './TerminalChat';
import { useLongPress } from '../hooks/useLongPress';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { getAiInitialCommand } from '../utils/aiProviders';
import { parseTerminalRuntimeInfo } from '../utils/terminalRuntimeInfo';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

export function MobileTerminalSurface({
  session,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  onRegisterFocusTerminal,
  onSessionBusyChange,
  sessionAiTypes,
  customAiProviders = [],
  onSetSessionAiType,
  onAddCustomAiProvider,
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);
  const [triggerHistoryPanel, setTriggerHistoryPanel] = useState(null);
  const [triggerScrollToBottom, setTriggerScrollToBottom] = useState(null);
  const [isTerminalScrolledUp, setIsTerminalScrolledUp] = useState(false);
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
  const sendTextRef = useRef(null);

  const currentAiType = session ? sessionAiTypes?.[session.id] : null;
  const runtimeInfo = useMemo(
    () => parseTerminalRuntimeInfo(terminalScreenSnapshot || terminalPreview, currentAiType),
    [currentAiType, terminalPreview, terminalScreenSnapshot]
  );
  const { listSessionGitBranches, checkoutSessionGitBranch } = useTerminalSession();

  const disconnectStartRef = useRef(null);
  const autoRemountTimerRef = useRef(null);
  const reconnectFeedbackTimerRef = useRef(null);
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => subscribeWindowActivity(setWindowActive), []);

  const dispatchTerminalCommand = useCallback((text) => {
    if (!text) return false;
    const sendText = sendTextRef.current;
    if (!sendText) return false;
    const accepted = sendText(text);
    if (accepted === false) return false;
    sendText('\r');
    return true;
  }, []);

  const handleToggleViewMode = useCallback(() => {
    setViewMode((current) => (current === 'terminal' ? 'reader' : 'terminal'));
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

  const handleRegisterSelectionActions = useCallback((actions) => {
    setSelectionActions(() => actions || null);
  }, []);

  const handleRegisterSendText = useCallback((sendText) => {
    sendTextRef.current = typeof sendText === 'function' ? sendText : null;
  }, []);

  const handleTerminalViewportStateChange = useCallback((atBottom) => {
    setIsTerminalScrolledUp(!atBottom);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    triggerScrollToBottom?.();
    setIsTerminalScrolledUp(false);
  }, [triggerScrollToBottom]);

  const handleActivityChange = useCallback((isBusy) => {
    onSessionBusyChange?.(session?.id, isBusy);
  }, [onSessionBusyChange, session?.id]);

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
      setRefreshToken((value) => value + 1);
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
  }, [session?.id]);

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
    if (!session?.id || !nextBranch || nextBranch === gitBranchInfo?.currentBranch) return;
    setIsSwitchingGitBranch(true);
    try {
      const result = await checkoutSessionGitBranch(session.id, nextBranch);
      if (result) {
        setGitBranchInfo(result);
      }
    } finally {
      setIsSwitchingGitBranch(false);
    }
  }, [checkoutSessionGitBranch, gitBranchInfo?.currentBranch, session?.id]);

  const handleTerminalLongPress = useCallback((coords) => {
    const items = [];
    const hasSelection = Boolean(selectionActions?.hasSelection?.());

    if (hasSelection) {
      items.push({
        label: 'Copy selection',
        onClick: () => selectionActions?.copySelection?.(),
      });
    }

    if (triggerHistoryPanel) {
      items.push({
        label: 'Open copy panel',
        onClick: () => triggerHistoryPanel?.(),
      });
    }

    items.push({
      label: viewMode === 'reader' ? 'Switch to Terminal' : 'Switch to Reader',
      onClick: handleToggleViewMode,
    });

    setTerminalContextMenu({
      x: coords?.x || 12,
      y: coords?.y || 12,
      items,
    });
  }, [handleToggleViewMode, selectionActions, triggerHistoryPanel, viewMode]);

  const longPressHandlers = useLongPress(handleTerminalLongPress);

  useEffect(() => {
    return () => {
      clearTimeout(autoRemountTimerRef.current);
      clearTimeout(reconnectFeedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setSelectionActions(null);
  }, [session?.id]);

  useEffect(() => {
    setTerminalPreview('');
    setTerminalScreenSnapshot('');
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id) return;

    let cancelled = false;
    setIsLoadingGitBranches(true);
    listSessionGitBranches(session.id)
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
  }, [listSessionGitBranches, session?.id]);

  useEffect(() => {
    setIsTerminalScrolledUp(false);
  }, [session?.id, viewMode]);

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {
      // Ignore storage failures.
    }
  }, [viewMode]);

  const handleSelectAiType = useCallback((nextAiType) => {
    if (!session?.id) return;
    onSetSessionAiType?.(session.id, nextAiType);
    const launchCommand = getAiInitialCommand(nextAiType, customAiProviders);
    if (launchCommand) {
      dispatchTerminalCommand(launchCommand);
    }
  }, [customAiProviders, dispatchTerminalCommand, onSetSessionAiType, session?.id]);

  const handleAddCustomAiCommand = useCallback((label, command) => {
    const provider = onAddCustomAiProvider?.(label, command);
    if (!provider?.id || !session?.id) return;
    onSetSessionAiType?.(session.id, provider.id);
    if (provider.initialCommand) {
      dispatchTerminalCommand(provider.initialCommand);
    }
  }, [dispatchTerminalCommand, onAddCustomAiProvider, onSetSessionAiType, session?.id]);

  if (!session) {
    return (
      <div className="mobile-terminal-carousel">
        <div className="empty-state">
          <h2>Welcome to Terminal</h2>
          <p>Create a new terminal session to get started.</p>
        </div>
      </div>
    );
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

      <div className="carousel-content" {...longPressHandlers}>
        <TerminalChat
          key={`${session.id}-${refreshToken}`}
          surface="mobile"
          sessionId={session.id}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          webglEnabled={webglEnabled}
          usesTmux={session.usesTmux}
          viewMode={viewMode}
          onScrollDirection={() => {}}
          onViewportStateChange={handleTerminalViewportStateChange}
          onRegisterImageUpload={handleRegisterImageUpload}
          onRegisterHistoryPanel={handleRegisterHistoryPanel}
          onRegisterSelectionActions={handleRegisterSelectionActions}
          onRegisterFocusTerminal={onRegisterFocusTerminal}
          onRegisterScrollToBottom={handleRegisterScrollToBottom}
          onRegisterSendText={handleRegisterSendText}
          onConnectionChange={handleConnectionChange}
          onActivityChange={handleActivityChange}
          onOutputChunk={handleOutputChunk}
          onScreenSnapshot={handleScreenSnapshot}
        />
      </div>

      <MobileStatusBar
        sessionId={session.id}
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
            dispatchTerminalCommand(launchCommand);
          }
        }}
        runtimeInfo={runtimeInfo}
        gitBranches={gitBranchInfo?.branches ?? []}
        currentGitBranch={gitBranchInfo?.currentBranch ?? null}
        isLoadingGitBranches={isLoadingGitBranches}
        isSwitchingGitBranch={isSwitchingGitBranch}
        onSelectGitBranch={handleSelectGitBranch}
      />

      {isTerminalScrolledUp && (
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
