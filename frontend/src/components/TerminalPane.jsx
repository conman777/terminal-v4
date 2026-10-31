import { environmentAllows } from '../utils/runtimePermissions';
import { getActiveEnvironment, getEnvironmentCacheScope, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';
import { resolveAgentLaunchCommand } from '../utils/agentLauncher';
import { useRef, useState, useCallback, useEffect, useMemo, useId, memo, useSyncExternalStore } from 'react';
import './TerminalPane.css';
import { LazyTerminalChat } from './LazyTerminalChat';
import { AgentModelPicker } from './AgentModelPicker';
import { serviceTierEntry } from '../utils/agentServiceTier';
import { ComposerPicker } from './ComposerPicker';
import { FollowupQueueButton } from './FollowupQueueButton';
import { ConversationContextButton } from './ConversationContextButton';
import { DesktopStatusBar } from './DesktopStatusBar';
import { latestWorkspaceResponse } from '../utils/workspaceResponse';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { useStructuredSession } from '../hooks/useStructuredSession';
import { useSessionBrowserApprovals } from '../hooks/useSessionBrowserApprovals';
import { useComposerDraft } from '../hooks/useComposerDraft';
import { useComposerFileAttachments } from '../hooks/useComposerFileAttachments';
import AttachmentDraftStatus from './AttachmentDraftStatus';
import { useSupervisedInputCapability } from '../hooks/useSupervisedInputCapability';
import { supervisedInputQueue } from '../utils/supervisedRawInputQueue';
import { useUserImageComposer } from '../hooks/useUserImageComposer';
import { LazyDesktopConversationView } from './LazyDesktopConversationView';
import { shouldFallbackToTerminalView } from '../utils/conversationMode';
import { getAiInitialCommand, getAiTypeOptions, inferSessionAiType } from '../utils/aiProviders';
import { useReadyAiOptions } from '../hooks/useReadyAiOptions';
import { getPreferredSessionTopic, isMeaningfulSessionTopic } from '../utils/sessionTopic';
import { isStructuredSessionId, getStructuredAgentLabel, getComposerPlaceholder } from '../utils/structuredSessions';
import { buildMentionThreads } from './composer-context/mentionThreads';
import { TerminalAddToChat, useTerminalAddToChat } from './composer-context/TerminalAddToChat';
import { resolveTerminalOwner } from './composer-context/addToChatState';
import { useCurrentPullRequest } from '../hooks/useCurrentPullRequest';
import { parseTerminalRuntimeInfo, resolveForegroundAiType } from '../utils/terminalRuntimeInfo';
import { ProjectBadge } from './ProjectBadge';
import { ThreadDetailsCard } from './ThreadDetailsCard';
import { ProviderAuthModal } from './ProviderAuthModal';
import { withAttachedFiles } from '../utils/attachedFiles';
import { PLAN_MARKER } from '../utils/planMode';
import { notifyAgent } from '../utils/agentNotifications';
import { loadStash, stashDraft, stashFailureMessage, takeStashed } from '../utils/draftStash';
import { getNativeFollowupQueue, newNativeFollowup } from '../utils/nativeFollowupQueue';
import { enqueueServerFollowup } from '../utils/serverFollowupQueue';
import { useServerFollowupQueue } from '../hooks/useServerFollowupQueue';
import { dismissLearningNudge, shouldNudgeLearning } from '../utils/learningNudge';
import { contextMeter } from '../utils/contextUsage';
import { OpenInEditorRow, PullRequestStatus, ThreadGitActions } from './ThreadCardActions';
import { ProjectScripts } from './ProjectScripts';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';
import { useWorkspaceGitStatus } from '../hooks/useWorkspaceGitStatus';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import { useThreadDrawerTerminal } from '../hooks/useThreadDrawerTerminal';
import { ThreadTerminalDrawer } from './ThreadTerminalDrawer';
import { isCompanionSession } from '../utils/sidebarSessionScope';
import { projectNameFromPath } from '../utils/projectBadge';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { ConversationLinksProvider, scopeConversationLinks, useConversationLinks } from '../contexts/ConversationLinksContext';

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ACCESS_OPTIONS = [
  { value: 'supervised', label: 'Supervised', description: 'Ask before editing files or running commands' },
  { value: 'auto-edit', label: 'Auto-edit', description: "Edit files in the thread's folder without asking" },
  { value: 'full', label: 'Full access', description: 'Edit and run anything without asking' },
];

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

function isReasonablePaneSummary(topic, isAutoGenerated) {
  if (!isMeaningfulSessionTopic(topic)) return false;
  if (typeof topic !== 'string') return false;
  const text = topic.trim();
  if (!text) return false;
  if (!isAutoGenerated) return true;

  // Auto-generated topics sometimes capture broken wrapped terminal fragments.
  if (/^[^A-Za-z0-9("'[]/.test(text)) return false;
  if (/[.·•]{2,}/.test(text.slice(0, 12))) return false;
  if (/[\x00-\x1f]/.test(text)) return false;

  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters / text.length < 0.4) return false;

  return true;
}

function getPaneSessionLabel(session) {
  if (!session) return 'Select terminal';
  return getPreferredSessionTopic(session.thread?.topic, session.title || 'New session');
}

const THREAD_DETAILS_KEY = 'tv4ThreadDetailsOpen';
function readThreadDetailsPreference() {
  try { return localStorage.getItem(THREAD_DETAILS_KEY) === 'true'; } catch { return false; }
}
function writeThreadDetailsPreference(open) {
  try { localStorage.setItem(THREAD_DETAILS_KEY, String(open)); } catch { /* preference is optional */ }
}

export const TerminalPane = memo(function TerminalPane(props) {
  const {
  pane,
  isActive,
  isFullscreen,
  sessions,
  canSplit,
  canClose,
  onSessionSelect,
  onSplit,
  onClose,
  onFocus,
  onFullscreen,
  showPreview,
  showBrowser = false,
  onToggleBrowser,
  onOpenFiles,
  onRevealProjectFile,
  onFindInThread,
  onStartThreadWithPrompt,
  onMinimizeMainTerminal,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  sessionActivity,
  projectInfo,
  sessionAiTypes,
  customAiProviders = [],
  onSetSessionAiType,
  onAddCustomAiProvider,
  onStartWorkspaceTask,
  onStartProjectChat,
  projects = [],
  recentFolders = [],
  onSelectHistorySession,
  onWorkspaceResponseChange,
  desktopAllowTerminalInput = false,
  onCwdChange,
  onSessionBusyChange,
  currentDesktopId,
  fitSignal,
  authLifecycle,
  strictReady,
  } = props;
  const strictProps = Object.hasOwn(props, 'authLifecycle') ? { authLifecycle, strictReady } : {};
  const conversationLinks = useConversationLinks();
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const terminalInputAllowed = environmentAllows(environment, 'terminalInput');
  const agentExecutionAllowed = environmentAllows(environment, 'agentExecute');
  const paneRef = useRef(null);
  const imageInputRef = useRef(null);
  const menuRef = useRef(null);
  const sessionTriggerRef = useRef(null);
  const sessionMenuId = useId();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isHeaderDragging, setIsHeaderDragging] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [threadAction, setThreadAction] = useState(null);
  const [threadRename, setThreadRename] = useState(null);
  const threadActionsRef = useRef(new Map());
  const [connectionState, setConnectionState] = useState('connecting');
  const [cwdSnapshot, setCwdSnapshot] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isSessionBusy, setIsSessionBusy] = useState(false);
  const [launchQueued, setLaunchQueued] = useState(false);
  const { value: composerValue, setValue: setComposerValue, revision: composerDraftRevision, clearIfUnchanged: clearComposerDraft, error: composerDraftError, store: composerStore } = useComposerDraft(pane.sessionId);
  const [composerAttachments, setComposerAttachments, attachmentDraftError, retryAttachmentDraft, restoredAttachments, attachmentConflict, useSavedAttachments, validateAttachmentDraft, getAttachmentSelectionToken, isAttachmentSelectionTokenCurrent, attachmentDraftSaving, dispatchWithAttachmentDraft, waitForAttachmentPersistence] = useComposerFileAttachments(pane.sessionId);
  const [composerSubmitting, setComposerSubmitting] = useState(false);
  const composerRequestRef = useRef(null);
  const composerSessionRef = useRef(pane.sessionId);
  composerSessionRef.current = pane.sessionId;
  const [modelUpdate, setModelUpdate] = useState(null);
  const modelRequestRef = useRef(null);
  const [viewModeNotice, setViewModeNotice] = useState('');
  const [isNoticePersistent, setIsNoticePersistent] = useState(false);
  const [terminalPreview, setTerminalPreview] = useState('');
  const [terminalScreenSnapshot, setTerminalScreenSnapshot] = useState('');
  const [interactivePromptEvent, setInteractivePromptEvent] = useState(null);
  const [isTerminalPanelOpen, setIsTerminalPanelOpen] = useState(false);
  // Terminal v4 stable: PTY is always the primary surface for terminal-backed sessions.
  // Codex dual-mode UI has been removed.
  // VS Code parity: once the terminal host has mounted for this session,
  // keep it alive while the dock is collapsed so WebGL/xterm aren't torn down.
  const [terminalRuntimeLatched, setTerminalRuntimeLatched] = useState(false);
  const [gitBranchInfo, setGitBranchInfo] = useState(null);
  const [isLoadingGitBranches, setIsLoadingGitBranches] = useState(false);
  const [isSwitchingGitBranch, setIsSwitchingGitBranch] = useState(false);
  const conversationFallbackRef = useRef(false);
  const interactivePromptRef = useRef(null);
  const outputProbeRef = useRef('');
  const hasConnectedOnceRef = useRef(false);
  const focusTerminalRef = useRef(null);
  const handleToggleTerminalPanel = useCallback(() => {
    setIsTerminalPanelOpen((isOpen) => {
      const next = !isOpen;
      if (next) {
        conversationFallbackRef.current = false;
        setIsNoticePersistent(false);
        setViewModeNotice('');
      }
      return next;
    });
  }, []);

  const { activeSessionId, listSessionGitBranches, checkoutSessionGitBranch, sendToSession, sendRawToSession, renameSession, updateThreadMetadata, updateStructuredSessionSelection, updateStructuredSessionAccess, createSession, closeSession, restoreSession } = useTerminalSession();

  const selectableSessions = useMemo(
    () => sessions.filter((session) => !session.thread?.archived && !isCompanionSession(session)),
    [sessions]
  );
  const mentionThreads = useMemo(() => buildMentionThreads(selectableSessions, pane.sessionId), [selectableSessions, pane.sessionId]);
  const currentSession = selectableSessions.find(s => s.id === pane.sessionId);
  const isV4Session = isStructuredSessionId(pane.sessionId) && currentSession?.runtime === 'v4';
  const isCodexSession = currentSession?.runtime === 'codex';
  const isManagedConversation = isV4Session || isCodexSession;
  const shouldHighlightActiveChrome = isActive && selectableSessions.length > 1;
  const inferredAiType = isManagedConversation ? inferSessionAiType(currentSession) : sessionAiTypes?.[pane.sessionId] ?? inferSessionAiType(currentSession);
  const rawTopic = currentSession?.thread?.topic || null;
  const useTopic = isReasonablePaneSummary(rawTopic, currentSession?.thread?.topicAutoGenerated);
  const paneSummaryText = (useTopic ? rawTopic : null) || currentSession?.title || null;
  const currentSessionLabel = getPaneSessionLabel(currentSession);
  const paneProjectName = projectNameFromPath(currentSession?.thread?.projectPath || currentSession?.cwd);
  const runtimeInfo = useMemo(
    () => parseTerminalRuntimeInfo(terminalScreenSnapshot || terminalPreview, inferredAiType),
    [inferredAiType, terminalPreview, terminalScreenSnapshot]
  );
  const currentAiType = isManagedConversation ? inferredAiType : resolveForegroundAiType(inferredAiType, runtimeInfo, terminalScreenSnapshot);
  const launchCommand = getAiInitialCommand(currentAiType, customAiProviders);
  const allAiOptions = useMemo(() => getAiTypeOptions(customAiProviders), [customAiProviders]);
  const aiOptions = useReadyAiOptions(allAiOptions, currentAiType);
  const showSessionSelector = Boolean(currentSession);
  const isStructuredSession = isStructuredSessionId(pane.sessionId);
  const rawInputMode = useSupervisedInputCapability(isStructuredSession, pane.sessionId);
  const isClaudeChat = isStructuredSession && !isManagedConversation && currentSession?.aiType === 'claude';
  const cwdSession = useRef({ id: pane.sessionId, generation: 0 });
  if (cwdSession.current.id !== pane.sessionId) cwdSession.current = { id: pane.sessionId, generation: cwdSession.current.generation + 1 };
  const cwdGeneration = cwdSession.current.generation;
  const currentCwd = cwdSnapshot?.sessionId === pane.sessionId && cwdSnapshot?.generation === cwdGeneration ? cwdSnapshot.cwd : null;

  const sessionCwd = isStructuredSession ? currentSession?.cwd || ''
    : currentCwd || currentSession?.cwd || (isActive ? projectInfo?.cwd : '') || '';
  const matchingProjectInfo = !isStructuredSession && sessionCwd && projectInfo?.cwd === sessionCwd ? projectInfo : null;
  const [detailsOpen, setDetailsOpen] = useState(() => readThreadDetailsPreference());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const providerSettingsTrigger = useRef(null);
  // Wide windows dock the card beside the conversation; narrower ones open it over the content on request.
  const installedSkills = useInstalledSkills(isStructuredSession ? sessionCwd : '');
  const [planMode, setPlanMode] = useState(false);
  const nativeQueue = useMemo(() => getNativeFollowupQueue(pane.sessionId), [pane.sessionId, composerStore]);
  const { items: queuedMessages, error: queueError } = useSyncExternalStore(nativeQueue.subscribe, nativeQueue.getSnapshot);
  const serverQueue = useServerFollowupQueue(isClaudeChat || isCodexSession ? pane.sessionId : null);
  const [stashed, setStashed] = useState(loadStash);
  const [stashError, setStashError] = useState('');
  const stashScope = useSyncExternalStore(subscribeEnvironment, () => { const scope = getEnvironmentCacheScope(); return `${scope.identity}|${scope.environment}`; });
  useEffect(() => { setStashed(loadStash()); setStashError(''); }, [stashScope]);
  useEffect(() => { setPlanMode(false); }, [pane.sessionId]);
  const detailsDocked = useMediaQuery('(min-width: 1280px)');
  const [floatingDetailsOpen, setFloatingDetailsOpen] = useState(false);
  const toggleDetails = useCallback(() => {
    if (!detailsDocked) { setFloatingDetailsOpen(open => !open); return; }
    setDetailsOpen(open => { writeThreadDetailsPreference(!open); return !open; });
  }, [detailsDocked]);
  const detailsVisible = Boolean(pane.sessionId) && isActive && (detailsDocked ? detailsOpen : floatingDetailsOpen);
  const threadGit = useWorkspaceGitStatus(sessionCwd, { enabled: detailsVisible });
  const drawerTerminal = useThreadDrawerTerminal({
    threadId: isStructuredSession ? pane.sessionId : null, cwd: sessionCwd, open: drawerOpen && terminalInputAllowed, enabled: terminalInputAllowed,
    sessions, createSession, closeSession, updateThreadMetadata, restoreSession,
  });
  const mentionPullRequests = useCurrentPullRequest(sessionCwd, threadGit.branch, { enabled: isStructuredSession && isActive });
  const mainTerminalOwner = useMemo(() => resolveTerminalOwner({ terminalId: pane.sessionId, sessions, activeThreadId: activeSessionId }), [activeSessionId, pane.sessionId, sessions]);
  const mainAddToChat = useTerminalAddToChat({ terminalId: pane.sessionId, owner: mainTerminalOwner, label: 'Terminal' });
  const drawerOwnerTitle = currentSession ? resolveTerminalOwner({ terminalId: pane.sessionId, sessions: [currentSession] })?.title : null;
  const drawerOwner = useMemo(() => (isStructuredSession && drawerOwnerTitle ? { threadId: pane.sessionId, title: drawerOwnerTitle } : null), [drawerOwnerTitle, isStructuredSession, pane.sessionId]);
  const sessionGitBranchInfo = gitBranchInfo?.sessionId === pane.sessionId ? gitBranchInfo : null;

  const sessionInputAllowed = isStructuredSession ? agentExecutionAllowed : terminalInputAllowed;
  const isTerminalBackedSession = Boolean(pane.sessionId) && !isStructuredSession;
  // Terminal v4 stable: terminal-backed sessions are always full-bleed PTY.
  // Structured (non-PTY) agent sessions keep the conversation surface.
  const useConversationFirstLayout = isStructuredSession;
  const useTerminalFirstLayout = isTerminalBackedSession;
  const shouldForcePromptDock = false;
  const isTerminalDockVisible = !isManagedConversation && (useTerminalFirstLayout || isTerminalPanelOpen);
  const shouldRenderTerminalRuntime = !isManagedConversation && (
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
    sessionId: pane.sessionId ?? null,
    chatMode: Boolean(pane.sessionId) && !isStructuredSession,
  });

  const {
    messages: structuredMessages,
    currentToolCalls: structuredToolCalls,
    pendingApproval,
    isStreaming: structuredIsStreaming,
    connectionState: structuredConnectionState,
    reconnect: structuredReconnect,
    isHistoryOnly: structuredHistoryOnly,
    sendMessage: structuredSendMessage,
    checkPendingMessage: structuredCheckPendingMessage,
    retryPendingMessage: structuredRetryPendingMessage,
    interrupt: structuredInterrupt,
    approve: structuredApprove,
    reviewApproval: structuredReviewApproval,
    isSending: structuredIsSending,
    isApproving: structuredIsApproving,
    isInterrupting: structuredIsInterrupting,
    requiresCleanup: structuredRequiresCleanup,
    actionError: structuredActionError,
    controlState: structuredControlState,
    contextUsage: structuredContextUsage,
    controlError: structuredControlError,
  } = useStructuredSession({
    ...strictProps,
    sessionId: isStructuredSession ? pane.sessionId : null,
    active: isStructuredSession,
    ...(isV4Session ? { aiType: currentSession.aiType, model: currentSession.model } : {}),
    ...(currentSession?.runtime ? { runtime: currentSession.runtime } : {}),
    ...(currentSession?.status ? { status: currentSession.status, statusSeq: currentSession.statusSeq } : {}),
  });
  const latestResponse = latestWorkspaceResponse(isStructuredSession ? structuredMessages : turns, isStructuredSession ? structuredIsStreaming : isSessionBusy);
  const composerContext = contextMeter(structuredContextUsage);
  const userTurns = isStructuredSession ? structuredMessages.filter(message => message.role === 'user').length : 0;
  const [learningNudgeHidden, setLearningNudgeHidden] = useState(0);
  const showLearningNudge = isStructuredSession && !structuredIsStreaming && sessionInputAllowed && Boolean(sessionCwd)
    && learningNudgeHidden !== userTurns && shouldNudgeLearning(pane.sessionId, userTurns);
  useEffect(() => { onWorkspaceResponseChange?.(pane.sessionId, latestResponse); }, [pane.sessionId, latestResponse, onWorkspaceResponseChange]);
  const canReviewBrowser = sessionInputAllowed && agentExecutionAllowed && !structuredIsInterrupting
    && !structuredRequiresCleanup && !structuredHistoryOnly && structuredConnectionState === 'online';
  const browserReview = useSessionBrowserApprovals({
    sessionId: pane.sessionId, enabled: isStructuredSession && !isV4Session, canDecide: canReviewBrowser,
  });
  const { userImages, sendDraft: sendImageDraft } = useUserImageComposer({
    session: isV4Session ? currentSession : null, active: isStructuredSession,
    store: composerStore, sendMessage: structuredSendMessage,
    checkPendingMessage: structuredCheckPendingMessage, retryPendingMessage: structuredRetryPendingMessage,
    conversationBusy: Boolean(structuredIsStreaming || ['accepted', 'running'].includes(currentSession?.status)),
    requiresCleanup: structuredRequiresCleanup, readOnly: !sessionInputAllowed,
  });
  const pendingApprovalKey = pendingApproval ? pendingApproval.approvalId || pendingApproval.seq || 'pending' : null;
  useEffect(() => { if (pendingApprovalKey) notifyAgent('approval', currentSession?.title); }, [pendingApprovalKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolvedConnectionState = isStructuredSession ? structuredConnectionState : connectionState;
  const headerStatus = !pane.sessionId ? 'No session'
    : resolvedConnectionState === 'unavailable' ? 'Unavailable'
    : resolvedConnectionState === 'offline' ? 'Offline'
    : resolvedConnectionState !== 'online' ? 'Connecting'
    : isStructuredSession && structuredIsInterrupting ? 'Stopping…'
    : isStructuredSession && structuredRequiresCleanup ? 'Needs attention'
    : isStructuredSession && pendingApproval?.toolName === 'ask_user' ? 'Waiting for your answer'
    : isStructuredSession && (pendingApproval || browserReview.requests.length > 0) ? 'Waiting for approval'
    : (isStructuredSession ? structuredIsStreaming : isSessionBusy) ? 'Working'
    : isStructuredSession ? 'Ready' : 'Connected';
  const headerStatusState = ['Needs attention', 'Waiting for approval', 'Waiting for your answer'].includes(headerStatus) ? 'attention'
    : ['Working', 'Stopping…'].includes(headerStatus) ? 'working'
    : resolvedConnectionState === 'online' ? 'ready' : resolvedConnectionState;

  useEffect(() => {
    if (isStructuredSession && pane.sessionId && structuredConnectionState === 'online') onSessionBusyChange?.(pane.sessionId, Boolean(structuredIsStreaming || structuredRequiresCleanup));
  }, [pane.sessionId, isStructuredSession, structuredConnectionState, structuredIsStreaming, structuredRequiresCleanup, onSessionBusyChange]);

  useEffect(() => {
    if (!viewModeNotice || isNoticePersistent) return;
    const timer = setTimeout(() => setViewModeNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [viewModeNotice, isNoticePersistent]);

  useEffect(() => {
    setIsSessionBusy(false);
    setShowSessionMenu(false);
    setThreadRename(null);
    setThreadAction(threadActionsRef.current.has(pane.sessionId) ? { sessionId: pane.sessionId, pending: true } : null);
    setIsTerminalPanelOpen(false);
    setTerminalRuntimeLatched(false);
    setConnectionState('connecting');
    setLaunchQueued(false);
    setComposerSubmitting(false); composerRequestRef.current = null;
    setModelUpdate(null); modelRequestRef.current = null;
    setTerminalPreview('');
    setTerminalScreenSnapshot('');
    setInteractivePromptEvent(null);
    setViewModeNotice('');
    setIsNoticePersistent(false);
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
    conversationFallbackRef.current = false;
    interactivePromptRef.current = null;
    focusTerminalRef.current = null;
    outputProbeRef.current = '';
    hasConnectedOnceRef.current = false;
    return () => { composerRequestRef.current = null; modelRequestRef.current = null; };
  }, [pane.sessionId]);

  useEffect(() => {
    if (!shouldForcePromptDock) return undefined;

    if (typeof requestAnimationFrame === 'function') {
      const frameId = requestAnimationFrame(() => {
        focusTerminalRef.current?.();
      });
      return () => cancelAnimationFrame(frameId);
    }

    focusTerminalRef.current?.();
    return undefined;
  }, [shouldForcePromptDock]);

  useEffect(() => {
    if (!isSendReady || !launchQueued) return;
    setLaunchQueued(false);
    setIsNoticePersistent(false);
    setViewModeNotice('');
  }, [isSendReady, launchQueued]);

  // Close session menu on outside click
  useEffect(() => {
    if (!showSessionMenu) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowSessionMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSessionMenu]);

  useEffect(() => {
    if (!pane.sessionId) return;
    if (isStructuredSession) {
      setGitBranchInfo(null);
      setIsLoadingGitBranches(false);
      return;
    }

    let cancelled = false;
    setIsLoadingGitBranches(true);
    listSessionGitBranches(pane.sessionId)
      .then((data) => {
        if (!cancelled) {
          setGitBranchInfo({ ...data, sessionId: pane.sessionId });
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
  }, [isStructuredSession, listSessionGitBranches, pane.sessionId, projectInfo?.gitBranch]);

  const handleSelectGitBranch = useCallback(async (nextBranch) => {
    if (!pane.sessionId || !nextBranch || nextBranch === sessionGitBranchInfo?.currentBranch) return;
    setIsSwitchingGitBranch(true);
    try {
      const result = await checkoutSessionGitBranch(pane.sessionId, nextBranch);
      if (result) {
        setGitBranchInfo({ ...result, sessionId: pane.sessionId });
      }
    } finally {
      setIsSwitchingGitBranch(false);
    }
  }, [checkoutSessionGitBranch, sessionGitBranchInfo?.currentBranch, pane.sessionId]);

  const handlePaneClick = (e) => {
    if (!e.target.closest('.ph-controls') && !e.target.closest('.ph-session-menu')) {
      onFocus(pane.id);
    }
  };

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const sessionId = e.dataTransfer.getData('session-id');
    if (sessionId) {
      onSessionSelect(pane.id, sessionId);
    }
  }, [pane.id, onSessionSelect]);

  const handleSessionClick = useCallback((e) => {
    e.stopPropagation();
    setShowSessionMenu(prev => !prev);
  }, []);

  const handleSessionSelect = useCallback((sessionId) => {
    onSessionSelect(pane.id, sessionId);
    setShowSessionMenu(false);
  }, [pane.id, onSessionSelect]);

  const handlePinThread = useCallback(async () => {
    if (!currentSession || threadActionsRef.current.has(currentSession.id)) return;
    const request = { sessionId: currentSession.id };
    threadActionsRef.current.set(request.sessionId, request);
    setThreadAction({ ...request, pending: true });
    try {
      await updateThreadMetadata(request.sessionId, { pinned: !currentSession.thread?.pinned });
      if (cwdSession.current.id === request.sessionId) { setThreadAction(null); setShowSessionMenu(false); }
    } catch (error) {
      if (cwdSession.current.id === request.sessionId) setThreadAction({ ...request, error: error.message || 'Unable to update thread.' });
    } finally {
      if (threadActionsRef.current.get(request.sessionId) === request) threadActionsRef.current.delete(request.sessionId);
    }
  }, [currentSession, updateThreadMetadata]);

  const handleRenameThread = useCallback(async (event) => {
    event.preventDefault();
    if (!currentSession || threadActionsRef.current.has(currentSession.id) || threadRename?.sessionId !== currentSession.id) return;
    const title = threadRename.value.trim();
    if (!title) return;
    const request = { sessionId: currentSession.id };
    const auth = captureAuthScope();
    const signal = getEnvironmentSignal();
    threadActionsRef.current.set(request.sessionId, request);
    setThreadAction({ ...request, pending: true });
    try {
      const result = await renameSession(request.sessionId, title);
      if (result?.ok === false) throw result.error || new Error('Unable to rename thread.');
      if (signal.aborted || signal !== getEnvironmentSignal() || !isAuthScopeCurrent(auth)) {
        throw new Error('The account or environment changed. Check the original thread before trying again.');
      }
      await updateThreadMetadata(request.sessionId, { topic: title, topicAutoGenerated: false });
      if (cwdSession.current.id === request.sessionId) { setThreadAction(null); setThreadRename(null); setShowSessionMenu(false); }
    } catch (error) {
      if (cwdSession.current.id === request.sessionId) setThreadAction({ ...request, error: error.message || 'Unable to rename thread.' });
    } finally {
      if (threadActionsRef.current.get(request.sessionId) === request) threadActionsRef.current.delete(request.sessionId);
    }
  }, [currentSession, renameSession, threadRename, updateThreadMetadata]);

  const handleImageUpload = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleConnectionChange = useCallback((connected) => {
    if (connected) {
      hasConnectedOnceRef.current = true;
      setConnectionState('online');
      return;
    }
    setConnectionState(hasConnectedOnceRef.current ? 'offline' : 'connecting');
  }, []);

  const handleActivityChange = useCallback((isBusy) => {
    setIsSessionBusy(Boolean(isBusy));
    onSessionBusyChange?.(pane.sessionId, isBusy);
  }, [onSessionBusyChange, pane.sessionId]);

  const handleOutputChunk = useCallback((chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    const chunkLooksInteractive = shouldFallbackToTerminalView(chunk);

    if (interactivePromptRef.current) {
      const normalizedChunk = chunk.toLowerCase();
      const stillLooksInteractive =
        /\[[yYnN]\/[yYnN]\]/.test(chunk)
        || normalizedChunk.includes('enter to confirm')
        || normalizedChunk.includes('esc to cancel')
        || normalizedChunk.includes('tab to cycle');
      if (!stillLooksInteractive) {
        interactivePromptRef.current = null;
        setInteractivePromptEvent(null);
        conversationFallbackRef.current = false;
        setIsNoticePersistent(false);
        setViewModeNotice('');
      }
    }

    if (conversationFallbackRef.current && !interactivePromptRef.current && !chunkLooksInteractive) {
      conversationFallbackRef.current = false;
      outputProbeRef.current = '';
      setIsNoticePersistent(false);
      setViewModeNotice('');
    }

    const previewLines = extractTerminalPreviewLines(chunk);
    if (previewLines.length > 0) {
      setTerminalPreview((previous) => {
        const prevLines = previous ? previous.split('\n') : [];
        const next = [...prevLines, ...previewLines].slice(-8).join('\n');
        return next === previous ? previous : next;
      });
    }

    if (conversationFallbackRef.current) return;

    outputProbeRef.current = `${outputProbeRef.current}${chunk}`.slice(-4000);
    if (!shouldFallbackToTerminalView(outputProbeRef.current)) return;

    conversationFallbackRef.current = true;
    setIsNoticePersistent(false);
    setViewModeNotice('');
  }, []);

  const handleCliEvent = useCallback((event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'prompt_required') {
      interactivePromptRef.current = event;
      setInteractivePromptEvent(event);
      setIsNoticePersistent(false);
      setViewModeNotice('');
      return;
    }

    if (event.type === 'assistant_turn' || event.type === 'user_turn') {
      interactivePromptRef.current = null;
      setInteractivePromptEvent(null);
      conversationFallbackRef.current = false;
      setIsNoticePersistent(false);
      setViewModeNotice('');
    }
  }, []);

  const handleScreenSnapshot = useCallback((snapshot) => {
    const next = typeof snapshot?.text === 'string' ? snapshot.text : '';
    setTerminalScreenSnapshot((previous) => (previous === next ? previous : next));
  }, []);

  const handleOpenTerminalPanel = useCallback(() => {
    setIsTerminalPanelOpen(true);
    conversationFallbackRef.current = false;
    setIsNoticePersistent(false);
    setViewModeNotice('');
  }, []);

  useEffect(() => {
    // Structured sessions may start without a terminal dock; terminal-backed
    // sessions always own the full surface so this flag is irrelevant there.
    if (!isStructuredSession) return;
    if (!desktopAllowTerminalInput) {
      setIsTerminalPanelOpen(false);
    }
  }, [desktopAllowTerminalInput, isStructuredSession]);

  const launchAiType = useCallback(async (aiTypeToLaunch, commandOverride = null) => {
    if (!environmentAllows(getActiveEnvironment(), 'terminalInput') || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return;
    try {
      const nextLaunchCommand = commandOverride || await resolveAgentLaunchCommand(aiTypeToLaunch, null, customAiProviders);
      if (!nextLaunchCommand) return;
      interactivePromptRef.current = null;
      setInteractivePromptEvent(null);
      const result = handleChatSend(nextLaunchCommand);
      if (result?.queued) {
        setLaunchQueued(true);
        setIsNoticePersistent(false);
        setViewModeNotice('Terminal is still connecting. Launch command queued.');
        return;
      }
      setLaunchQueued(false);
      setIsNoticePersistent(false);
      setViewModeNotice('');
    } catch (error) { setIsNoticePersistent(true); setViewModeNotice(error.message || 'Unable to start this agent'); }
  }, [customAiProviders, handleChatSend]);

  const handleLaunchAgent = useCallback(() => {
    launchAiType(currentAiType);
  }, [currentAiType, launchAiType]);

  const composerRouteRef = useRef('');
  composerRouteRef.current = JSON.stringify([pane.sessionId, Boolean(structuredIsStreaming), serverQueue.status,
    serverQueue.snapshot?.revision ?? null, serverQueue.snapshot?.order?.length ?? 0, queueError,
    queuedMessages.map(item => [item.id, item.status]), Boolean(userImages),
    userImages?.items?.map(item => [item.localId, item.status]) ?? [], planMode,
    currentSession?.model, currentSession?.reasoning, currentSession?.serviceTier,
    sessionInputAllowed, structuredHistoryOnly, structuredRequiresCleanup, structuredConnectionState,
    structuredIsSending, structuredIsInterrupting]);
  const sendImageDraftRef = useRef(sendImageDraft);
  sendImageDraftRef.current = sendImageDraft;
  const structuredSendMessageRef = useRef(structuredSendMessage);
  structuredSendMessageRef.current = structuredSendMessage;

  const handleComposerSubmit = useCallback(async (text) => {
    if (attachmentDraftError || !validateAttachmentDraft()) return;
    if (isStructuredSession && structuredConnectionState === 'unavailable') return;
    if (!pane.sessionId || composerRequestRef.current || !environmentAllows(getActiveEnvironment(), isStructuredSession ? 'agentExecute' : 'terminalInput')) return;
    if ((isClaudeChat || isCodexSession) && queueError && !queueError.startsWith('The follow-up queue could not be saved')) return;
    if (queuedMessages.some(item => item.status === 'editing')) return;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const submittedAttachments = composerAttachments;
    const submittedDraftRevision = composerDraftRevision;
    const attachmentPaths = submittedAttachments.map(attachment => attachment?.path).filter(path => typeof path === 'string' && path.trim());
    const payload = isV4Session && userImages ? withAttachedFiles(typeof text === 'string' ? text : '', attachmentPaths)
      : isStructuredSession ? `${planMode && (isClaudeChat || isCodexSession) ? PLAN_MARKER : ''}${withAttachedFiles(trimmed, attachmentPaths)}`
        : [attachmentPaths.join(' '), trimmed].filter(Boolean).join(' ').trim();
    if (!payload.trim() && !(isV4Session && userImages?.items.length)) return;
    if ((isClaudeChat || isCodexSession) && serverQueue.status === 'unknown' && structuredIsStreaming) {
      setIsNoticePersistent(true); setViewModeNotice('Checking the follow-up queue. Your draft was kept; try again in a moment.');
      return;
    }
    const request = {};
    composerRequestRef.current = request;
    setComposerSubmitting(true);
    const sessionId = pane.sessionId;
    const route = composerRouteRef.current;
    const queueing = (isClaudeChat || isCodexSession) && serverQueue.status === 'available' && (structuredIsStreaming || serverQueue.snapshot?.order.length);
    try {
      const admission = await dispatchWithAttachmentDraft(submittedAttachments,
        () => composerSessionRef.current === sessionId && composerRouteRef.current === route && composerRequestRef.current === request
          && environmentAllows(getActiveEnvironment(), isStructuredSession ? 'agentExecute' : 'terminalInput'),
        async () => {
          if (queueing) {
            const queued = await enqueueServerFollowup(sessionId, payload);
            if (composerRequestRef.current !== request) return;
            clearComposerDraft(submittedDraftRevision, trimmed);
            setComposerAttachments(current => current.filter(attachment => !submittedAttachments.includes(attachment)));
            serverQueue.refresh();
            setIsNoticePersistent(false);
            setViewModeNotice(queued.mode === 'held' ? 'Queued on the server. The queue is paused: open Queue to resume it.' : 'Queued on the server.');
            return;
          }
          if ((isClaudeChat || isCodexSession) && (structuredIsStreaming || queuedMessages.length)) {
            if (composerDraftError && queuedMessages.some(item => item.text === payload)) return;
            const item = newNativeFollowup(payload);
            if (!nativeQueue.update(current => [...current, item])) return;
            if (!composerDraftError) clearComposerDraft(submittedDraftRevision, trimmed);
            setComposerAttachments(current => current.filter(attachment => !submittedAttachments.includes(attachment)));
            return;
          }
          const result = isV4Session && userImages ? await sendImageDraftRef.current(payload)
            : isStructuredSession ? await structuredSendMessageRef.current(payload) : handleChatSend(payload);
          if (result?.completion) await result.completion;
          if (composerRequestRef.current !== request) return;
          if (isStructuredSession && result?.accepted !== true) {
            setIsNoticePersistent(true); setViewModeNotice('Message was not accepted. Your draft was kept.');
            return;
          }
          if (!result?.draftManaged) {
            clearComposerDraft(submittedDraftRevision, trimmed);
            setComposerAttachments(current => current.filter(attachment => !submittedAttachments.includes(attachment)));
          }
          setIsNoticePersistent(false); setViewModeNotice(result?.queued ? 'Terminal is still connecting. Command queued.' : '');
        });
      if (admission.started) await admission.completion;
      else if (composerRequestRef.current === request) { setIsNoticePersistent(true); setViewModeNotice('The conversation or file selection changed while preparing. Your draft was kept; try again.'); }
    } catch (error) {
      if (composerRequestRef.current === request) { setIsNoticePersistent(true); setViewModeNotice(error.message || (queueing ? 'Could not queue this message. Your draft was kept.' : 'Send failed. Your draft was kept.')); }
    } finally {
      if (composerRequestRef.current === request) { composerRequestRef.current = null; setComposerSubmitting(false); }
    }
  }, [attachmentDraftError, validateAttachmentDraft, dispatchWithAttachmentDraft, composerAttachments, composerDraftError, composerDraftRevision, clearComposerDraft, handleChatSend, isClaudeChat, isCodexSession, isStructuredSession, isV4Session, nativeQueue, pane.sessionId, planMode, queueError, queuedMessages, serverQueue, structuredIsStreaming, structuredConnectionState, structuredSendMessage, userImages, sendImageDraft, setComposerAttachments]);

  const modelUpdatePending = modelUpdate?.sessionId === pane.sessionId && modelUpdate.pending;
  const modelUpdateError = modelUpdate?.sessionId === pane.sessionId ? modelUpdate.error : '';
  const modelChangeDisabled = !sessionInputAllowed || modelUpdatePending || composerSubmitting
    || Boolean(structuredIsStreaming || structuredIsSending || structuredIsInterrupting || structuredRequiresCleanup)
    || structuredConnectionState !== 'online';

  const handleSelectModel = useCallback(async (next) => {
    const sessionId = pane.sessionId;
    if (!(isCodexSession || isClaudeChat) || !sessionId || modelChangeDisabled || modelRequestRef.current || !next?.model) return;
    const serviceTierChanged = next.serviceTier !== undefined && (next.serviceTier ?? null) !== (currentSession?.serviceTier ?? null);
    if (next.model === currentSession?.model && (next.reasoning || '') === (currentSession?.reasoning || '') && !serviceTierChanged) return;
    const request = {};
    modelRequestRef.current = request;
    setModelUpdate({ sessionId, pending: true, error: '' });
    try {
      await updateStructuredSessionSelection(sessionId, { model: next.model, reasoning: next.reasoning || null, ...(serviceTierChanged ? { serviceTier: next.serviceTier } : {}) });
      if (modelRequestRef.current === request) setModelUpdate(null);
    } catch (error) {
      if (modelRequestRef.current === request) setModelUpdate({ sessionId, pending: false, error: error.message || 'Unable to change the model. The previous model is still selected.' });
    } finally {
      if (modelRequestRef.current === request) modelRequestRef.current = null;
    }
  }, [currentSession?.model, currentSession?.reasoning, currentSession?.serviceTier, isClaudeChat, isCodexSession, modelChangeDisabled, pane.sessionId, updateStructuredSessionSelection]);

  const projectPaths = [...new Set([sessionCwd, ...projects.map(project => project.path), ...recentFolders].filter(Boolean))];

  const handleStructuredRawSend = useCallback(async (data) => {
    if (!pane.sessionId) return undefined;
    if (!['legacy', 'supervised'].includes(rawInputMode)) { setIsNoticePersistent(true); setViewModeNotice('Terminal input is unavailable or still being checked.'); return undefined; }
    const sessionId = pane.sessionId;
    const options = rawInputMode === 'supervised' ? { requireSupervision: true } : { requireLegacy: true };
    supervisedInputQueue(sessionId, text => sendRawToSession ? sendRawToSession(sessionId, text, options) : sendToSession(sessionId, text), rawInputMode).enqueue(data);
    return undefined;
  }, [pane.sessionId, sendToSession, sendRawToSession, rawInputMode]);

  const handleComposerAttachmentAdd = useCallback((attachment) => {
    if (!attachment?.path) return;
    setComposerAttachments((current) => {
      if (current.some((item) => item.path === attachment.path)) return current;
      return [...current, attachment];
    });
  }, [setComposerAttachments]);

  const handleComposerAttachmentRemove = useCallback((pathToRemove) => {
    setComposerAttachments((current) => current.filter((attachment) => attachment.path !== pathToRemove));
  }, [setComposerAttachments]);

  const handleRegisterImageUploadTrigger = useCallback((trigger) => {
    imageInputRef.current = { click: trigger };
  }, []);

  const handleRegisterFocusTerminal = useCallback((focusFn) => {
    focusTerminalRef.current = typeof focusFn === 'function' ? focusFn : null;
  }, []);

  const handleSelectAiType = useCallback((nextAiType) => {
    if (!pane.sessionId) return;
    onSetSessionAiType?.(pane.sessionId, nextAiType);
    if (nextAiType) {
      launchAiType(nextAiType);
    }
  }, [launchAiType, onSetSessionAiType, pane.sessionId]);

  const handleAddCustomAiCommand = useCallback((label, command) => {
    if (!pane.sessionId) return;
    const provider = onAddCustomAiProvider?.(label, command);
    if (!provider?.id) return;
    onSetSessionAiType?.(pane.sessionId, provider.id);
    launchAiType(provider.id, provider.initialCommand);
  }, [launchAiType, onAddCustomAiProvider, onSetSessionAiType, pane.sessionId]);

  useEffect(() => {
    const head = queuedMessages[0];
    if (!head || serverQueue.status === 'available') return;
    if (structuredIsStreaming && head.status === 'waiting') {
      nativeQueue.update(current => current.map(item => item.id === head.id ? { ...item, status: 'queued' } : item));
      return;
    }
    if (!(isClaudeChat || isCodexSession) || !sessionInputAllowed || structuredHistoryOnly || structuredRequiresCleanup || structuredConnectionState !== 'online') return;
    if (structuredIsStreaming || head.status !== 'queued') return;
    if (!nativeQueue.update(current => current[0]?.id === head.id && current[0].status === 'queued'
      ? current.map(item => item.id === head.id ? { ...item, status: 'sending' } : item) : current)) return;
    (async () => {
      let accepted = false;
      try { accepted = (await structuredSendMessage(head.text))?.accepted === true; } catch { /* Keep an unconfirmed send for review. */ }
      const saved = nativeQueue.update(current => {
        const index = current.findIndex(item => item.id === head.id && item.status === 'sending');
        if (index < 0) return current;
        const updated = [...current];
        if (accepted) {
          updated.splice(index, 1);
          if (index === 0 && updated[0]?.status === 'queued') updated[0] = { ...updated[0], status: 'waiting' };
        } else updated[index] = { ...updated[index], status: 'held' };
        return updated;
      });
      if (!saved) nativeQueue.holdLocal(head.id);
    })();
  }, [isClaudeChat, isCodexSession, nativeQueue, queuedMessages, serverQueue.status, sessionInputAllowed, structuredConnectionState, structuredHistoryOnly, structuredIsStreaming, structuredRequiresCleanup, structuredSendMessage]);
  const stashCurrentDraft = useCallback(() => {
    if (!composerValue.trim()) return;
    const result = stashDraft(composerValue);
    if (!result.ok) {
      setStashError(stashFailureMessage(result));
      return;
    }
    setStashError('');
    setStashed(result.items);
    setComposerValue('');
  }, [composerValue, setComposerValue]);
  const restoreStashed = useCallback(id => {
    const text = takeStashed(id);
    setStashed(loadStash());
    if (text) setComposerValue(composerValue.trim() ? `${composerValue.trimEnd()}\n${text}` : text);
  }, [composerValue, setComposerValue]);

  const handleImplementPlan = useCallback(async () => {
    setPlanMode(false);
    const result = await structuredSendMessage('Implement the plan above.');
    if (result?.accepted !== true) { setIsNoticePersistent(true); setViewModeNotice('The agent did not accept the request to implement the plan.'); }
  }, [structuredSendMessage]);
  const handleImplementPlanInNewThread = useCallback(plan => {
    onStartThreadWithPrompt?.(`Implement this plan:\n\n${plan}`, currentSession);
  }, [currentSession, onStartThreadWithPrompt]);

  const handleRunScript = useCallback(script => {
    createSession?.({ cwd: sessionCwd, title: script.name, initialCommand: script.command })
      .catch(error => { setIsNoticePersistent(true); setViewModeNotice(error.message || `Could not run ${script.name}.`); });
  }, [createSession, sessionCwd]);

  const handleSelectAccess = useCallback(async (mode) => {
    const sessionId = pane.sessionId;
    if (!sessionId || mode === (currentSession?.accessMode || 'auto-edit')) return;
    try {
      await updateStructuredSessionAccess(sessionId, mode);
    } catch (error) {
      setModelUpdate({ sessionId, pending: false, error: error.message || 'Unable to change access. The previous setting is still in use.' });
    }
  }, [currentSession?.accessMode, pane.sessionId, updateStructuredSessionAccess]);

  const handleCwdChange = useCallback((cwd) => {
    if (cwdSession.current.id !== pane.sessionId || cwdSession.current.generation !== cwdGeneration) return;
    setCwdSnapshot({ sessionId: pane.sessionId, generation: cwdGeneration, cwd });
    onCwdChange?.(cwd);
  }, [cwdGeneration, onCwdChange, pane.sessionId]);

  const handleRefreshTerminal = useCallback(() => {
    if (isStructuredSession) { structuredReconnect?.(); return; }
    setRefreshToken((value) => value + 1);
  }, [isStructuredSession, structuredReconnect]);

  const handleHeaderDragStart = useCallback((e) => {
    if (!pane.sessionId) return;
    e.dataTransfer.setData('pane-drag', JSON.stringify({
      paneId: pane.id,
      sessionId: pane.sessionId,
      fromDesktopId: currentDesktopId
    }));
    e.dataTransfer.effectAllowed = 'move';
    setIsHeaderDragging(true);
  }, [pane.id, pane.sessionId, currentDesktopId]);

  const handleHeaderDragEnd = useCallback(() => {
    setIsHeaderDragging(false);
  }, []);

  return (
    <div
      ref={paneRef}
      className={`split-terminal-pane terminal-pane-ui ${isActive ? 'active' : ''} ${isFullscreen ? 'fullscreen' : ''} ${isDragOver ? 'drag-over' : ''}${sessionAiTypes?.[pane.sessionId] ? ` pane-ai-${sessionAiTypes[pane.sessionId]}` : ''}`}
      onClick={handlePaneClick}
      onFocusCapture={() => { if (!isActive) onFocus?.(pane.id); }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`ph-bar terminal-pane-header${isHeaderDragging ? ' is-dragging-pane' : ''}`}
        draggable={Boolean(pane.sessionId)}
        onDragStart={handleHeaderDragStart}
        onDragEnd={handleHeaderDragEnd}
      >
        <div className="ph-left">
          <div className="ph-identity">
            {paneProjectName && <span className="ph-project" title={sessionCwd || paneProjectName}>
              {onOpenFiles && sessionCwd ? <button type="button" className="ph-project-btn" aria-label="Open project in Files" onClick={event => { event.stopPropagation(); if (!isActive) onFocus?.(pane.id); onOpenFiles(sessionCwd); }}>
                <ProjectBadge name={paneProjectName} /><span className="ph-project-name">{paneProjectName}</span>
              </button> : <><ProjectBadge name={paneProjectName} /><span className="ph-project-name">{paneProjectName}</span></>}
              <span className="ph-crumb-sep" aria-hidden="true">/</span>
            </span>}
            {!showSessionSelector && <span className="ph-title" title={currentSessionLabel}>{currentSessionLabel}</span>}
            {!isStructuredSession && sessionCwd && <span className="ph-cwd" title={sessionCwd}>{sessionCwd}</span>}
            {showSessionSelector && (
              <div className="ph-session" ref={menuRef} onKeyDown={event => {
                if (event.key === 'Escape' && showSessionMenu) {
                  event.preventDefault(); event.stopPropagation();
                  setShowSessionMenu(false);
                  sessionTriggerRef.current?.focus();
                }
              }}>
                <button
                  ref={sessionTriggerRef}
                  type="button"
                  className="ph-session-btn"
                  onClick={handleSessionClick}
                  aria-label={currentSessionLabel}
                  title={currentSessionLabel}
                  aria-expanded={showSessionMenu}
                  aria-controls={showSessionMenu ? sessionMenuId : undefined}
                >
                  <span className="ph-session-name">
                    {currentSessionLabel}
                  </span>
                  <svg aria-hidden="true" className="ph-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {showSessionMenu && (
                  <div className="ph-session-menu" id={sessionMenuId} role="group" aria-label="Switch session">
                    <div className="ph-menu-label">Thread</div>
                    {threadRename?.sessionId === pane.sessionId ? <form className="ph-rename-form" onSubmit={handleRenameThread}>
                      <input autoFocus aria-label="Thread title" value={threadRename.value}
                        disabled={threadAction?.sessionId === pane.sessionId && threadAction.pending}
                        onChange={event => setThreadRename({ sessionId: pane.sessionId, value: event.target.value })} />
                      <button type="submit" className="ph-menu-item" disabled={!threadRename.value.trim() || (threadAction?.sessionId === pane.sessionId && threadAction.pending)}>Save thread title</button>
                      <button type="button" className="ph-menu-item" disabled={threadAction?.sessionId === pane.sessionId && threadAction.pending} onClick={() => { setThreadRename(null); setThreadAction(null); }}>Cancel</button>
                    </form> : <button type="button" className="ph-menu-item" disabled={!renameSession || (threadAction?.sessionId === pane.sessionId && threadAction.pending)}
                      onClick={() => { setThreadAction(null); setThreadRename({ sessionId: pane.sessionId, value: currentSessionLabel }); }}>Rename thread</button>}
                    <button type="button" className="ph-menu-item" disabled={threadAction?.sessionId === pane.sessionId && threadAction.pending} onClick={handlePinThread}>
                      {currentSession?.thread?.pinned ? 'Unpin thread' : 'Pin thread'}
                    </button>
                    {threadAction?.sessionId === pane.sessionId && threadAction.error && <div role="alert" className="ph-menu-error">{threadAction.error}</div>}
                    <div className="ph-menu-label">Switch session</div>
                    {selectableSessions.map(session => {
                      const hasUnread = sessionActivity?.[session.id]?.hasUnread;
                      const isCurrentSession = session.id === pane.sessionId;
                      const sessionLabel = getPaneSessionLabel(session);
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={`ph-menu-item ${isCurrentSession ? 'active' : ''}`}
                          aria-current={isCurrentSession ? 'true' : undefined}
                          onClick={() => handleSessionSelect(session.id)}
                        >
                          {hasUnread && <span className="ph-menu-dot" />}
                          <span className="ph-menu-title">{sessionLabel}</span>
                          {isCurrentSession && (
                            <svg aria-hidden="true" className="ph-menu-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                    {selectableSessions.length === 0 && (
                      <div className="ph-menu-empty">No sessions available</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <span className="ph-status" role="status" data-state={headerStatusState}>{headerStatus}</span>
        </div>

        <div className="ph-controls" role="group" aria-label="Pane controls">
          {isStructuredSession && onFindInThread && <button
            type="button"
            className="ph-btn"
            aria-label="Find in thread"
            title="Find in thread"
            onClick={event => {
              event.stopPropagation();
              const opener = event.currentTarget;
              opener.focus({ preventScroll: true });
              if (!isActive) onFocus?.(pane.id);
              onFindInThread(pane.id, pane.sessionId, opener);
            }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></svg>
          </button>}
          {pane.sessionId && <button
            type="button"
            className="ph-btn"
            aria-label="Toggle thread details panel"
            aria-pressed={detailsVisible}
            title="Thread details"
            onClick={event => { event.stopPropagation(); toggleDetails(); }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h10M7 17h6" /></svg>
          </button>}
          {isStructuredSession && <button
            type="button"
            className="ph-btn"
            aria-label="Toggle terminal drawer"
            aria-pressed={drawerOpen}
            title="Terminal drawer"
            onClick={event => { event.stopPropagation(); setDrawerOpen(open => !open); }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 15h18" /></svg>
          </button>}
          {onToggleBrowser && <button
            type="button"
            className="ph-btn ph-browser-btn"
            aria-label="Toggle browser pane"
            aria-pressed={showBrowser}
            title="Browser"
            onClick={event => { event.stopPropagation(); onToggleBrowser(); }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
          </button>}
          <span className="ph-divider" />
          {/* Reconnect */}
          <button
            type="button"
            className="ph-btn"
            onClick={(e) => { e.stopPropagation(); handleRefreshTerminal(); }}
            title="Reconnect terminal"
            aria-label="Reconnect terminal"
          >
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>

          {/* Split buttons */}
          {canSplit && !isFullscreen && (
            <>

              <button
                type="button"
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'horizontal'); }}
                title="Split side by side"
                aria-label="Split horizontally"
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
                  <line x1="7" y1="2" x2="7" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'vertical'); }}
                title="Split top and bottom"
                aria-label="Split vertically"
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
                  <line x1="1.5" y1="7" x2="12.5" y2="7" />
                </svg>
              </button>
            </>
          )}

          {/* Minimize to show preview */}
          {showPreview && !isFullscreen && onMinimizeMainTerminal && (
            <>

              <button
                type="button"
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onMinimizeMainTerminal(); }}
                title="Minimize terminal (show browser)"
                aria-label="Minimize terminal"
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="2" width="6" height="10" rx="1" />
                  <polyline points="8 5 11 7 8 9" />
                </svg>
              </button>
            </>
          )}

          {/* Fullscreen */}
          {selectableSessions.length > 1 && (
            <>
              <span className="ph-divider" />
              <button
                type="button"
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onFullscreen(pane.id); }}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polyline points="5 1.5 1.5 1.5 1.5 5" />
                    <polyline points="9 12.5 12.5 12.5 12.5 9" />
                    <line x1="1.5" y1="1.5" x2="5.5" y2="5.5" />
                    <line x1="8.5" y1="8.5" x2="12.5" y2="12.5" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polyline points="8.5 1.5 12.5 1.5 12.5 5.5" />
                    <polyline points="5.5 12.5 1.5 12.5 1.5 8.5" />
                    <line x1="12.5" y1="1.5" x2="8.5" y2="5.5" />
                    <line x1="1.5" y1="12.5" x2="5.5" y2="8.5" />
                  </svg>
                )}
              </button>
            </>
          )}

          {/* Close pane */}
          {canClose && !isFullscreen && (
            <button
              type="button"
              className="ph-btn ph-btn-close"
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              title="Close pane"
              aria-label="Close pane"
            >
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="pane-content">
        {isStructuredSession && structuredHistoryOnly && <p role="status" aria-label="Connection recovery" className="remote-readonly-notice">{structuredActionError}</p>}
        {composerDraftError && composerDraftError !== structuredActionError && <p role="alert" className="remote-readonly-notice">{composerDraftError}</p>}
        {attachmentDraftError && <AttachmentDraftStatus error={attachmentDraftError} conflict={attachmentConflict} currentItems={composerAttachments} onRetry={retryAttachmentDraft} onUseSaved={useSavedAttachments} />}
        {attachmentDraftSaving && <p role="status" className="remote-readonly-notice">Saving file selections…</p>}
        {restoredAttachments && !attachmentDraftError && <p role="status" className="remote-readonly-notice">Restored file selections. Check the files before sending; they may have changed.</p>}
        {modelUpdateError && <p role="alert" className="remote-readonly-notice">{modelUpdateError}</p>}
        {modelUpdatePending && <p role="status" className="remote-readonly-notice">Updating model for the next turn…</p>}
        {!sessionInputAllowed && <p role="status" className="remote-readonly-notice">Read-only access: this device can view this session. Ask its owner to grant input permission.</p>}
        {detailsVisible && <ThreadDetailsCard
          floating={!detailsDocked}
          machine={environment?.label || environment?.url || 'This server'}
          cwd={sessionCwd}
          git={threadGit}
          onOpenFiles={onOpenFiles}
          renderChanges={({ icon, label }) => <WorkspaceToolsButton initialTool="git" ariaLabel="Review changes" icon={icon} label={label}
            workspacePath={sessionCwd} currentSessionId={pane.sessionId} onStartTask={onStartWorkspaceTask} />}
          editorAction={<OpenInEditorRow cwd={sessionCwd} />}
          scriptsAction={sessionCwd && environmentAllows(environment, 'terminalInput') ? <ProjectScripts cwd={sessionCwd} onRun={handleRunScript} /> : null}
        >
          {threadGit.branch && <ThreadGitActions cwd={sessionCwd} branch={threadGit.branch} files={threadGit.files} onChanged={threadGit.refresh} />}
          {threadGit.branch && <PullRequestStatus cwd={sessionCwd} branch={threadGit.branch} />}
        </ThreadDetailsCard>}
        {isV4Session && <ProviderAuthModal isOpen={providerSettingsOpen} focusProviderId={currentSession?.aiType || null}
          onClose={() => { setProviderSettingsOpen(false); requestAnimationFrame(() => providerSettingsTrigger.current?.focus()); }} />}
        {pane.sessionId ? (
          <div className={`terminal-with-status${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
            <div className={`desktop-terminal-stack${isTerminalPanelOpen ? ' terminal-panel-open' : ''}${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
              {/* CliActivityStrip removed — interactive prompts handled in terminal directly */}
              {!useTerminalFirstLayout && useConversationFirstLayout && (
                <div className="desktop-conversation-surface">
                  <ConversationLinksProvider value={scopeConversationLinks(conversationLinks, sessionCwd, isActive, conversationLinks?.openPaneFile && ((path, line) => {
                    onFocus?.(pane.id);
                    conversationLinks.openPaneFile({ desktopId: currentDesktopId, paneId: pane.id, sessionId: pane.sessionId, root: sessionCwd, path, line });
                  }))}>
                  <LazyDesktopConversationView
                    showHeader={!isStructuredSession}
                    turns={turns}
                    isStreaming={isStructuredSession ? structuredIsStreaming : isSessionBusy}
                    isLoadingHistory={!isStructuredSession && isConversationHistoryLoading}
                    onSend={sessionInputAllowed ? (isStructuredSession ? structuredSendMessage : handleChatSend) : undefined}
                    onSendRaw={!isManagedConversation && sessionInputAllowed ? (isStructuredSession ? handleStructuredRawSend : handleRawSend) : undefined}
                    onInterrupt={sessionInputAllowed ? (isStructuredSession ? structuredInterrupt : handleInterrupt) : undefined}
                    onImageUpload={!isV4Session && sessionInputAllowed && environmentAllows(environment, 'fileWrite') && environmentAllows(environment, 'transfer') ? handleImageUpload : undefined}
                    sessionId={pane.sessionId}
                    workspacePath={isStructuredSession ? sessionCwd : ''}
                    filePreviewVisible={isActive}
                    onRevealProjectFile={isActive && onRevealProjectFile ? target => onRevealProjectFile({ ...target, paneId: pane.id, desktopId: currentDesktopId }) : undefined}
                    aiType={currentAiType}
                    connectionState={resolvedConnectionState}
                    isSendReady={isStructuredSession ? structuredConnectionState === 'online' : isSendReady}
                    terminalPreview={terminalPreview}
                    terminalScreenSnapshot={terminalScreenSnapshot}
                    launchCommand={isStructuredSession ? '' : launchCommand}
                    launchQueued={launchQueued}
                    onLaunchAgent={!isStructuredSession && terminalInputAllowed && agentExecutionAllowed ? handleLaunchAgent : undefined}
                    onOpenTerminal={isStructuredSession && !isManagedConversation ? handleOpenTerminalPanel : undefined}
                    conversationNotice={viewModeNotice}
                    showTerminalMirror={Boolean(interactivePromptEvent) || isNoticePersistent}
                    interactivePromptEvent={interactivePromptEvent}
                    isTerminalDockVisible={isTerminalDockVisible}
                    mode={isStructuredSession ? 'structured' : 'terminal'}
                    structuredMessages={structuredMessages}
                    structuredToolCalls={structuredToolCalls}
                    pendingApproval={pendingApproval}
                    browserApprovals={browserReview.requests}
                    onBrowserApprove={canReviewBrowser ? browserReview.decide : undefined}
                    isBrowserApproving={browserReview.isDeciding}
                    browserApprovalError={browserReview.error}
                    isApproving={structuredIsApproving}
                    isInterrupting={structuredIsInterrupting}
                    requiresCleanup={structuredRequiresCleanup}
                    actionError={structuredActionError}
                    onApprove={agentExecutionAllowed ? structuredApprove : undefined}
                    onReviewApproval={agentExecutionAllowed ? structuredReviewApproval : undefined}
                    allowApprovalForSession={isCodexSession || isClaudeChat}
                    onImplementPlan={(isCodexSession || isClaudeChat) && sessionInputAllowed ? handleImplementPlan : undefined}
                    onImplementPlanInNewThread={(isCodexSession || isClaudeChat) && onStartThreadWithPrompt ? handleImplementPlanInNewThread : undefined}
                    onEditMessage={isStructuredSession && sessionInputAllowed ? setComposerValue : undefined}
                    onDiffComment={isStructuredSession && sessionInputAllowed ? note => setComposerValue(`${composerValue.trimEnd() ? `${composerValue.trimEnd()}\n` : ''}${note}`) : undefined}
                    onForkFromMessage={(isCodexSession || isClaudeChat) && onStartThreadWithPrompt ? prompt => onStartThreadWithPrompt(prompt, currentSession) : undefined}
                    allowPromptKeyboardCapture={terminalInputAllowed && desktopAllowTerminalInput === true && (!isStructuredSession || ['legacy', 'supervised'].includes(rawInputMode))}
                  />
                  </ConversationLinksProvider>
                </div>
              )}

              <div
                className={`desktop-terminal-slot${isTerminalDockVisible ? ' is-open' : ' is-collapsed'}${useTerminalFirstLayout ? ' terminal-first' : ''}${shouldForcePromptDock ? ' prompt-docked' : ''}`}
                aria-hidden={!isTerminalDockVisible ? 'true' : undefined}
              >
                <div className="desktop-terminal-runtime-host" data-persistent-terminal="">
                  {shouldRenderTerminalRuntime ? (
                    <LazyTerminalChat
                      {...strictProps}
                      key={`${pane.sessionId}-${refreshToken}`}
                      surface="desktop"
                      filePreviewThreadId={isStructuredSession ? pane.sessionId : undefined}
                      filePreviewRoot={isStructuredSession ? sessionCwd : undefined}
                      sessionId={pane.sessionId}
                      keybarOpen={keybarOpen}
                      viewportHeight={viewportHeight}
                      onUrlDetected={onUrlDetected}
                      fontSize={fontSize}
                      webglEnabled={webglEnabled}
                      inputEnabled={terminalInputAllowed && (useTerminalFirstLayout || (isStructuredSession && (desktopAllowTerminalInput || shouldForcePromptDock)))}
                      usesTmux={currentSession?.usesTmux}
                      viewMode="terminal"
                      isPrimary={isActive && isTerminalDockVisible}
                      fitSignal={fitSignal}
                      onRegisterImageUpload={handleRegisterImageUploadTrigger}
                      onConnectionChange={handleConnectionChange}
                      onCwdChange={handleCwdChange}
                      onActivityChange={handleActivityChange}
                      onOutputChunk={handleOutputChunk}
                      onScreenSnapshot={handleScreenSnapshot}
                      onCliEvent={handleCliEvent}
                      onRegisterFocusTerminal={handleRegisterFocusTerminal}
                      onRegisterSendText={handleRegisterSendText}
                      onRegisterSelectionActions={mainAddToChat.register}
                      onTurn={handleTurn}
                    />
                  ) : null}
                </div>
                {isTerminalDockVisible && <TerminalAddToChat state={mainAddToChat} />}
              </div>
              {useTerminalFirstLayout && viewModeNotice && <div role="alert" className="terminal-input-error">{viewModeNotice}</div>}
              {showLearningNudge && <div className="session-queued-message session-learning-nudge" role="status" aria-label="Save what was learned">
                <span className="session-queued-text">Worth remembering anything from this conversation for next time?</span>
                <WorkspaceToolsButton initialTool="learning" label="Review what to remember" workspacePath={sessionCwd} currentSessionId={pane.sessionId}
                  latestAssistantText={latestResponse?.text || ''} onInsertPrompt={text => setComposerValue(text)} onStartTask={onStartWorkspaceTask} />
                <button type="button" onClick={() => { dismissLearningNudge(pane.sessionId, userTurns); setLearningNudgeHidden(userTurns); }}>Not now</button>
              </div>}
              {queueError && <div role="alert" className="terminal-input-error">{queueError}</div>}
              {queuedMessages.map(item => <div key={item.id} className="session-queued-message" role="status" aria-label="Queued message">
                <span className="session-queued-label">{serverQueue.status === 'available' ? 'Tab-only, not sent automatically · ' : 'Tab-only queue · '}{item.status === 'held' ? 'Send unconfirmed' : item.status === 'sending' ? 'Sending' : item.status === 'editing' ? 'Original retained' : item.status === 'recovered' ? 'Restored for review' : item.status === 'waiting' ? 'Waiting for previous response' : 'Queued'}</span>
                <span className="session-queued-text">{item.text}</span>
                {item.status === 'held' && <span>Check the conversation before removing this message; it may have been sent.</span>}
                {item.status === 'recovered' && <span>Check the conversation before resuming; another tab may have sent this message.</span>}
                {item.status === 'editing' && <span>Remove this copy before sending your edited draft.</span>}
                {serverQueue.status !== 'available' && (item.status === 'recovered' || item.status === 'waiting' && !structuredIsStreaming) && <button type="button" onClick={() => {
                  nativeQueue.update(current => current.map(queued => queued.id === item.id ? { ...queued, status: 'queued' } : queued));
                }}>Resume queue</button>}
                {serverQueue.status !== 'available' && item.status === 'queued' && <button type="button" onClick={() => structuredInterrupt?.()} disabled={structuredIsInterrupting || !structuredIsStreaming}>Send now</button>}
                {(item.status === 'queued' || item.status === 'recovered') && <button type="button" onClick={() => {
                  if (nativeQueue.update(current => current.map(queued => queued.id === item.id ? { ...queued, status: 'editing' } : queued)))
                    setComposerValue(current => current ? `${current}\n\n${item.text}` : item.text);
                }}>Edit</button>}
                {(item.status === 'editing' || item.status === 'held' || serverQueue.status === 'available') && <button type="button" onClick={() => {
                  nativeQueue.update(current => current.filter(queued => queued.id !== item.id));
                }}>Remove queued copy</button>}
              </div>)}
              <DesktopStatusBar
                compactConversation={isStructuredSession}
                showTopRow={isStructuredSession ? false : undefined}
                composerSubmitLabel={isStructuredSession ? 'Send message' : 'Send to terminal'}
                isStreaming={isStructuredSession && structuredIsStreaming}
                isInterrupting={isStructuredSession && structuredIsInterrupting}
                requiresCleanup={isStructuredSession && structuredRequiresCleanup}
                onInterrupt={isStructuredSession && sessionInputAllowed ? structuredInterrupt : undefined}
                sessionId={pane.sessionId}
                sessionTitle={currentSession?.title}
                sessionSummary={paneSummaryText}
                cwd={sessionCwd}
                gitBranch={isStructuredSession ? undefined : sessionGitBranchInfo?.currentBranch || matchingProjectInfo?.gitBranch}
                isActive={shouldHighlightActiveChrome}
                onImageUpload={!isV4Session && sessionInputAllowed && environmentAllows(environment, 'fileWrite') && environmentAllows(environment, 'transfer') ? handleImageUpload : undefined}
                isTerminalPanelOpen={!useTerminalFirstLayout && isTerminalDockVisible}
                showTerminalToggle={!useTerminalFirstLayout && isStructuredSession && !isManagedConversation}
                onToggleTerminalPanel={!useTerminalFirstLayout && isStructuredSession && !isManagedConversation ? handleToggleTerminalPanel : undefined}
                terminalViewMode="terminal"
                showTerminalViewModeToggle={false}
                onToggleTerminalViewMode={undefined}
                connectionState={resolvedConnectionState}
                aiType={currentAiType}
                aiOptions={aiOptions}
                customAiProviders={customAiProviders}
                onSelectAiType={!isManagedConversation ? handleSelectAiType : undefined}
                showAiSelector={!isManagedConversation && !isStructuredSession}
                onAddCustomAiCommand={handleAddCustomAiCommand}
                onLaunchAi={handleLaunchAgent}
                composerValue={composerValue}
                composerDraftStore={composerStore}
                composerAttachments={composerAttachments}
                attachmentsEnabled
                skills={installedSkills}
                mentionRoot={isStructuredSession ? sessionCwd : ''}
                mentionThreads={isStructuredSession ? mentionThreads : undefined}
                mentionPullRequests={isStructuredSession ? mentionPullRequests : undefined}
                allowAnyFile={isStructuredSession && !isV4Session}
                showImageButton
                userImages={isV4Session ? userImages : undefined}
                onComposerChange={setComposerValue}
                onComposerSubmit={handleComposerSubmit}
                onComposerAttachmentAdd={handleComposerAttachmentAdd}
                onComposerAttachmentRemove={handleComposerAttachmentRemove}
                waitForAttachmentPersistence={waitForAttachmentPersistence}
                getAttachmentSelectionToken={getAttachmentSelectionToken}
                isAttachmentSelectionTokenCurrent={isAttachmentSelectionTokenCurrent}
                composerPlaceholder={sessionInputAllowed ? getComposerPlaceholder({ isStructuredSession, session: currentSession, foregroundAiType: currentAiType, customProviders: customAiProviders }) : "Read-only remote session"}
                composerSubmitDisabled={Boolean(attachmentDraftError) || attachmentDraftSaving || (isStructuredSession && (structuredHistoryOnly || structuredConnectionState === 'unavailable')) || queuedMessages.some(item => item.status === 'editing')}
                composerDisabled={!pane.sessionId || !sessionInputAllowed || composerSubmitting || modelUpdatePending || (isStructuredSession && (structuredIsSending || structuredIsInterrupting))}
                runtimeInfo={isStructuredSession ? { label: `${getStructuredAgentLabel(currentSession)}${currentSession?.model ? ` · ${currentSession.model}` : ''}` } : runtimeInfo}
                gitBranches={sessionGitBranchInfo?.branches || []}
                currentGitBranch={isStructuredSession ? null : sessionGitBranchInfo?.currentBranch || matchingProjectInfo?.gitBranch || null}
                isLoadingGitBranches={isLoadingGitBranches}
                isSwitchingGitBranch={isSwitchingGitBranch}
                onSelectGitBranch={environmentAllows(environment, 'fileWrite') ? handleSelectGitBranch : undefined}
                composerSecondaryAction={(
                  <div className="status-permission-picker">
                    {isCodexSession ? <>
                      <ComposerPicker label="Project" menuTitle="New chat in project" value={sessionCwd} placeholder="Choose project"
                        className="workspace-start-project-picker" disabled={!onStartProjectChat}
                        icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>}
                        options={projectPaths.map(path => ({ value: path, label: projects.find(project => project.path === path)?.name || path.split(/[\\/]/).filter(Boolean).pop() || path, description: path === sessionCwd ? 'Current conversation' : `Start a new chat in ${path}` }))}
                        onChange={path => { if (path !== sessionCwd) onStartProjectChat?.(path); }}
                        action={onStartProjectChat ? { label: 'Browse for project folder', text: 'New chat in another folder…', onClick: () => onStartProjectChat(null) } : undefined} />
                      <div className="workspace-start-model" aria-busy={modelUpdatePending ? 'true' : undefined}>
                        <AgentModelPicker compact agentId="codex" syncSelection={false} disabled={modelChangeDisabled}
                          value={currentSession?.model ? { model: currentSession.model, reasoning: currentSession.reasoning || '', ...serviceTierEntry(currentSession.serviceTier) } : null}
                          onChange={handleSelectModel} />
                      </div>
                    </> : isClaudeChat ? <div className="workspace-start-model" aria-busy={modelUpdatePending ? 'true' : undefined}>
                        <AgentModelPicker compact agentId="claude" syncSelection={false} disabled={modelChangeDisabled}
                          value={currentSession?.model ? { model: currentSession.model, reasoning: currentSession.reasoning || '' } : null}
                          onChange={handleSelectModel} />
                      </div> : isStructuredSession && (isV4Session
                        ? <button type="button" ref={providerSettingsTrigger} className="session-composer-context session-composer-provider" aria-haspopup="dialog" aria-label={`Provider settings: ${getStructuredAgentLabel(currentSession)}${currentSession?.model ? ` · ${currentSession.model}` : ''}`} title="Provider settings" onClick={() => setProviderSettingsOpen(true)}>{getStructuredAgentLabel(currentSession)}{currentSession?.model ? ` · ${currentSession.model}` : ''}</button>
                        : <span className="session-composer-context">{getStructuredAgentLabel(currentSession)}{currentSession?.model ? ` · ${currentSession.model}` : ''}</span>)}
                    <div className="session-composer-actions">
                    {(isV4Session || serverQueue.status === 'available') && <FollowupQueueButton sessionId={pane.sessionId} queue={serverQueue} />}
                    {isV4Session && <ConversationContextButton
                      sessionId={pane.sessionId} active={true}
                      controlState={structuredControlState}
                      onStopConversation={sessionInputAllowed ? structuredInterrupt : undefined}
                      isStopping={structuredIsInterrupting} stopError={structuredControlError}
                      requiresCleanup={structuredRequiresCleanup}
                      conversationBusy={Boolean(structuredIsStreaming || ['accepted', 'running'].includes(currentSession?.status))}
                      readOnly={!sessionInputAllowed}
                    />}
                    {isStructuredSession && <ComposerPicker label="Stashed drafts" menuTitle="Stashed drafts" className="session-stash-picker" placeholder={stashed.length ? `Stash (${stashed.length})` : 'Stash'}
                      value="" disabled={!stashed.length && !composerValue.trim()}
                      options={stashed.map(item => ({ value: item.id, label: item.text.slice(0, 60), description: new Date(item.at).toLocaleString() }))}
                      onChange={restoreStashed}
                      action={composerValue.trim() ? { label: 'Stash this draft', text: 'Stash this draft', onClick: stashCurrentDraft } : undefined} />}
                    {isStructuredSession && stashError && <span className="session-stash-error" role="alert">{stashError}</span>}
                    {(isClaudeChat || isCodexSession) && composerContext && <span className="session-context-meter" role="img" aria-label={`${composerContext.label}: ${composerContext.detail}`} title={composerContext.detail}>
                      <svg width="14" height="14" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--border-default)" strokeWidth="4" /><circle cx="18" cy="18" r="15" fill="none" stroke={composerContext.percent > 85 ? 'var(--error)' : 'var(--accent-primary)'} strokeWidth="4" strokeDasharray={`${composerContext.percent * 0.9425} 94.25`} transform="rotate(-90 18 18)" /></svg>
                      <span>{composerContext.percent}%</span>
                    </span>}
                    {(isClaudeChat || isCodexSession) && <button type="button" className={`session-plan-toggle${planMode ? ' active' : ''}`}
                      aria-label="Plan mode" aria-pressed={planMode} title="Plan first: the agent proposes a plan without changing anything"
                      onClick={() => setPlanMode(value => !value)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
                      <span>Plan</span>
                    </button>}
                    {(isClaudeChat || isCodexSession) && <ComposerPicker label="Access" menuTitle="Access" className="session-access-picker"
                      value={currentSession?.accessMode || 'auto-edit'} options={ACCESS_OPTIONS}
                      disabled={modelChangeDisabled} onChange={handleSelectAccess}
                      icon={<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0 1.75 2.5v4.16c0 4.09 2.56 7.8 6.25 9.34 3.69-1.54 6.25-5.25 6.25-9.34V2.5L8 0Zm4.75 6.66c0 3.26-1.93 6.22-4.75 7.62-2.82-1.4-4.75-4.36-4.75-7.62V3.52L8 1.63l4.75 1.89v3.14Z" /></svg>} />}
                    </div>
                  </div>
                )}
              />
              {isStructuredSession && drawerOpen && <ThreadTerminalDrawer {...strictProps} threadId={pane.sessionId} drawer={drawerTerminal} terminalInputAllowed={terminalInputAllowed}
                sessionCwd={sessionCwd} fontSize={fontSize} webglEnabled={webglEnabled} isActive={isActive} fitSignal={fitSignal} owner={drawerOwner}
                onRequestClose={() => setDrawerOpen(false)} onRequestReopen={() => setDrawerOpen(true)} />}
            </div>
          </div>
        ) : (
          <div className="pane-empty pane-home">
            <div className="pane-home-copy">
              <span className="pane-home-kicker">Workspace</span>
              <h2>Select a terminal to get started</h2>
              <p>Pick an active thread from the sidebar, or create a new terminal to start sending prompts and commands.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
