import { withAttachedFiles } from '../utils/attachedFiles';
import { environmentAllows } from '../utils/runtimePermissions';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';
import { resolveAgentLaunchCommand } from '../utils/agentLauncher';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LazyTerminalChat } from './LazyTerminalChat';
import { LazyDesktopConversationView } from './LazyDesktopConversationView';
import { FollowupQueueButton } from './FollowupQueueButton';
import { enqueueServerFollowup } from '../utils/serverFollowupQueue';
import { useServerFollowupQueue } from '../hooks/useServerFollowupQueue';
import { ConversationContextButton } from './ConversationContextButton';
import { DesktopStatusBar } from './DesktopStatusBar';
import { MobileModelSettings } from './MobileModelSettings';
import { serviceTierEntry } from '../utils/agentServiceTier';
import { MobileKeybar } from './MobileKeybar';
import { WorkspaceStartView } from './WorkspaceStartView';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { useStructuredSession } from '../hooks/useStructuredSession';
import { useSessionBrowserApprovals } from '../hooks/useSessionBrowserApprovals';
import { useComposerDraft } from '../hooks/useComposerDraft';
import { useComposerFileAttachments } from '../hooks/useComposerFileAttachments';
import AttachmentDraftStatus from './AttachmentDraftStatus';
import { useSupervisedInputCapability } from '../hooks/useSupervisedInputCapability';
import { supervisedInputQueue } from '../utils/supervisedRawInputQueue';
import { latestWorkspaceResponse } from '../utils/workspaceResponse';
import { useUserImageComposer } from '../hooks/useUserImageComposer';
import { useThreadDrawerTerminal } from '../hooks/useThreadDrawerTerminal';
import { ThreadTerminalTabs } from './ThreadTerminalTabs';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import { PLAN_MARKER } from '../utils/planMode';
import { getAiInitialCommand, getAiTypeOptions, inferSessionAiType } from '../utils/aiProviders';
import { useReadyAiOptions } from '../hooks/useReadyAiOptions';
import { getPreferredSessionTopic } from '../utils/sessionTopic';
import { isStructuredSessionId, getStructuredAgentLabel, getComposerPlaceholder } from '../utils/structuredSessions';
import { buildMentionThreads } from './composer-context/mentionThreads';
import { useTerminalAddToChat } from './composer-context/TerminalAddToChat';
import { resolveTerminalOwner } from './composer-context/addToChatState';
import { useCurrentPullRequest } from '../hooks/useCurrentPullRequest';
import { useLongPress } from '../hooks/useLongPress';
import { ContextMenu } from './ContextMenu';
import { resolveWorktreeOrigin } from '../utils/worktreeOrigin';
import { parseTerminalRuntimeInfo, resolveForegroundAiType } from '../utils/terminalRuntimeInfo';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import './MobileUI.css';

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
  visible = true,
  sessions = [],
  terminalSessions = sessions,
  threadTerminalOpen = false,
  activeSessionId = null,
  onSelectSession,
  onSelectHistorySession,
  onWorkspaceResponseChange,
  onCreateSession,
  onOpenImageConversation,
  onReviewImageConversation,
  onSubmitPrompt,
  onAddWorkspace,
  startWorkspacePath,
  startProjects = [],
  recentFolders = [],
  onSelectWorkspace,
  showWorkspaceStart = false,
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
  const [cwdSnapshot, setCwdSnapshot] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [composerSubmitting, setComposerSubmitting] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const threadStartRequestRef = useRef(null);
  const [modelUpdate, setModelUpdate] = useState(null);
  const modelRequestRef = useRef(null);
  const composerRequestRef = useRef(null);
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
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const { listSessionGitBranches, checkoutSessionGitBranch, updateStructuredSessionSelection, createSession, updateThreadMetadata, restoreSession, sendRawToSession } = useTerminalSession();

  const currentSession = useMemo(
    () => showWorkspaceStart ? null : activeSessionId ? sessions.find((session) => session.id === activeSessionId) || null : sessions[0] || null,
    [activeSessionId, sessions, showWorkspaceStart]
  );
  const mentionThreads = useMemo(() => buildMentionThreads(sessions, currentSession?.id), [sessions, currentSession?.id]);
  const worktreeOrigin = useMemo(() => resolveWorktreeOrigin(sessions, activeSessionId), [sessions, activeSessionId]);
  const [composerAttachments, setComposerAttachments, attachmentDraftError, retryAttachmentDraft, restoredAttachments, attachmentConflict, useSavedAttachments, validateAttachmentDraft, getAttachmentSelectionToken, isAttachmentSelectionTokenCurrent] = useComposerFileAttachments(currentSession?.id);
  const { value: composerValue, setValue: setComposerValue, revision: composerDraftRevision, clearIfUnchanged: clearComposerDraft, error: composerDraftError, store: composerStore } = useComposerDraft(currentSession?.id);
  const isStructuredSession = isStructuredSessionId(currentSession?.id);
  const rawInputMode = useSupervisedInputCapability(isStructuredSession, currentSession?.id);
  const cwdSession = useRef({ id: currentSession?.id, generation: 0 });
  if (cwdSession.current.id !== currentSession?.id) cwdSession.current = { id: currentSession?.id, generation: cwdSession.current.generation + 1 };
  const cwdGeneration = cwdSession.current.generation;
  const currentCwd = cwdSnapshot?.sessionId === currentSession?.id && cwdSnapshot?.generation === cwdGeneration ? cwdSnapshot.cwd : null;

  const sessionCwd = isStructuredSession ? currentSession?.cwd || ''
    : currentCwd || currentSession?.cwd || projectInfo?.cwd || '';
  const matchingProjectInfo = !isStructuredSession && sessionCwd && projectInfo?.cwd === sessionCwd ? projectInfo : null;
  const sessionGitBranchInfo = gitBranchInfo?.sessionId === currentSession?.id ? gitBranchInfo : null;

  const handleCwdChange = useCallback((cwd) => {
    if (cwdSession.current.id !== currentSession?.id || cwdSession.current.generation !== cwdGeneration) return;
    setCwdSnapshot({ sessionId: currentSession?.id, generation: cwdGeneration, cwd });
  }, [cwdGeneration, currentSession?.id]);

  const isV4Session = isStructuredSession && currentSession?.runtime === 'v4';
  const isCodexSession = currentSession?.runtime === 'codex';
  const isManagedConversation = isV4Session || isCodexSession;
  const isClaudeChat = isStructuredSession && !isManagedConversation && currentSession?.aiType === 'claude';
  const serverQueue = useServerFollowupQueue(isClaudeChat || isCodexSession ? currentSession?.id : null);
  const installedSkills = useInstalledSkills(isStructuredSession ? sessionCwd : '');
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  useEffect(() => { setPlanMode(false); }, [environment?.id]);
  const terminalPermissionAllowed = environmentAllows(environment, 'terminalInput');
  const terminalInputAllowed = visible && terminalPermissionAllowed;
  const threadTerminal = useThreadDrawerTerminal({
    threadId: isStructuredSession ? currentSession?.id : null,
    cwd: sessionCwd,
    open: Boolean(threadTerminalOpen && terminalPermissionAllowed),
    active: visible,
    enabled: terminalPermissionAllowed,
    sessions: terminalSessions,
    createSession,
    updateThreadMetadata,
    restoreSession,
  });
  const mentionPullRequests = useCurrentPullRequest(sessionCwd, null, { enabled: isStructuredSession && visible });
  const mainTerminalOwner = useMemo(() => resolveTerminalOwner({ terminalId: currentSession?.id, sessions: terminalSessions }), [currentSession?.id, terminalSessions]);
  const mainAddToChat = useTerminalAddToChat({ terminalId: currentSession?.id, owner: mainTerminalOwner, label: 'Terminal' });
  const drawerOwnerTitle = currentSession ? resolveTerminalOwner({ terminalId: currentSession.id, sessions: [currentSession] })?.title : null;
  const drawerOwner = useMemo(() => (isStructuredSession && drawerOwnerTitle ? { threadId: currentSession.id, title: drawerOwnerTitle } : null), [currentSession?.id, drawerOwnerTitle, isStructuredSession]);
  const drawerAddToChat = useTerminalAddToChat({ terminalId: threadTerminal.terminalId, owner: drawerOwner, label: 'Thread terminal' });
  const [selectionMenu, setSelectionMenu] = useState(null);
  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
  const openSelectionMenu = useCallback((addToChat, coords) => {
    if (addToChat.menuItems.length) setSelectionMenu({ x: coords?.x || 12, y: coords?.y || 12, items: addToChat.menuItems });
  }, []);
  const mainSelectionPress = useLongPress(useCallback(coords => openSelectionMenu(mainAddToChat, coords), [mainAddToChat, openSelectionMenu]));
  const drawerSelectionPress = useLongPress(useCallback(coords => openSelectionMenu(drawerAddToChat, coords), [drawerAddToChat, openSelectionMenu]));
  useEffect(() => { setSelectionMenu(null); }, [currentSession?.id, threadTerminal.terminalId]);
  const agentExecutionAllowed = visible && environmentAllows(environment, 'agentExecute');
  const sessionInputAllowed = isStructuredSession ? agentExecutionAllowed : terminalInputAllowed;
  const inferredAiType = currentSession ? (isManagedConversation ? inferSessionAiType(currentSession) : sessionAiTypes[currentSession.id] ?? inferSessionAiType(currentSession)) : null;
  const allAiOptions = useMemo(
    () => getAiTypeOptions(customAiProviders),
    [customAiProviders]
  );
  const runtimeInfo = useMemo(
    () => parseTerminalRuntimeInfo(terminalScreenSnapshot || terminalPreview, inferredAiType),
    [inferredAiType, terminalPreview, terminalScreenSnapshot]
  );
  const currentAiType = isManagedConversation ? inferredAiType : resolveForegroundAiType(inferredAiType, runtimeInfo, terminalScreenSnapshot);
  const aiOptions = useReadyAiOptions(allAiOptions, currentAiType);
  const launchCommand = useMemo(
    () => getAiInitialCommand(currentAiType, customAiProviders),
    [currentAiType, customAiProviders]
  );
  const isTerminalBackedSession = Boolean(currentSession?.id) && !isStructuredSession;
  // Terminal v4 stable: terminal-backed sessions always show the full PTY.
  const useConversationFirstLayout = isStructuredSession;
  const useTerminalFirstLayout = isTerminalBackedSession;
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
    sessionId: currentSession?.id ?? null,
    chatMode: Boolean(currentSession?.id) && !isStructuredSession,
  });

  const {
    messages: structuredMessages,
    currentToolCalls: structuredToolCalls,
    pendingApproval,
    isStreaming: structuredIsStreaming,
    connectionState: structuredConnectionState,
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
    controlError: structuredControlError,
  } = useStructuredSession({
    sessionId: isStructuredSession ? currentSession?.id ?? null : null,
    active: isStructuredSession,
    ...(isV4Session ? { aiType: currentSession.aiType, model: currentSession.model } : {}),
    ...(currentSession?.runtime ? { runtime: currentSession.runtime } : {}),
    ...(currentSession?.status ? { status: currentSession.status, statusSeq: currentSession.statusSeq } : {}),
  });
  const latestResponse = latestWorkspaceResponse(isStructuredSession ? structuredMessages : turns, isStructuredSession ? structuredIsStreaming : isTerminalBusy);
  useEffect(() => { onWorkspaceResponseChange?.(currentSession?.id, latestResponse); }, [currentSession?.id, latestResponse, onWorkspaceResponseChange]);
  const canReviewBrowser = sessionInputAllowed && agentExecutionAllowed && !structuredIsInterrupting
    && !structuredRequiresCleanup && !structuredHistoryOnly && structuredConnectionState === 'online';
  const browserReview = useSessionBrowserApprovals({
    sessionId: currentSession?.id, enabled: isStructuredSession && !isV4Session, canDecide: canReviewBrowser,
  });
  const { userImages, sendDraft: sendImageDraft } = useUserImageComposer({
    session: isV4Session ? currentSession : null, active: isStructuredSession,
    store: composerStore, sendMessage: structuredSendMessage,
    checkPendingMessage: structuredCheckPendingMessage, retryPendingMessage: structuredRetryPendingMessage,
    conversationBusy: Boolean(structuredIsStreaming || ['accepted', 'running'].includes(currentSession?.status)),
    requiresCleanup: structuredRequiresCleanup, readOnly: !sessionInputAllowed,
  });
  const resolvedConnectionState = isStructuredSession ? structuredConnectionState : connectionState;
  const scopedModelUpdate = modelUpdate?.sessionId === currentSession?.id ? modelUpdate : null;
  const modelUpdatePending = Boolean(scopedModelUpdate?.pending);
  const modelUpdateError = scopedModelUpdate?.error || '';
  const modelChangeDisabled = !sessionInputAllowed || modelUpdatePending || composerSubmitting
    || structuredIsStreaming || structuredIsSending || structuredIsInterrupting || structuredRequiresCleanup
    || structuredHistoryOnly || structuredConnectionState !== 'online';

  useEffect(() => {
    modelRequestRef.current = null;
    setModelUpdate(null);
    return () => { modelRequestRef.current = null; };
  }, [currentSession?.id, environment]);

  const handleSelectModel = useCallback(async next => {
    const sessionId = currentSession?.id;
    if (!(isCodexSession || isClaudeChat) || !sessionId || modelChangeDisabled || modelRequestRef.current || !next?.model) return;
    const serviceTierChanged = isCodexSession && next.serviceTier !== undefined && (next.serviceTier ?? null) !== (currentSession.serviceTier ?? null);
    if (next.model === currentSession.model && (next.reasoning || '') === (currentSession.reasoning || '') && !serviceTierChanged) return;
    const request = {};
    modelRequestRef.current = request;
    setModelUpdate({ sessionId, pending: true, error: '' });
    try {
      await updateStructuredSessionSelection(sessionId, { model: next.model, reasoning: next.reasoning || null, ...(serviceTierChanged ? { serviceTier: next.serviceTier } : {}) });
      if (modelRequestRef.current === request) setModelUpdate(null);
    } catch (error) {
      if (modelRequestRef.current === request) setModelUpdate({ sessionId, pending: false, error: error.message || 'Unable to change the model.' });
    } finally {
      if (modelRequestRef.current === request) modelRequestRef.current = null;
    }
  }, [currentSession, isClaudeChat, isCodexSession, modelChangeDisabled, updateStructuredSessionSelection]);

  useEffect(() => {
    if (isStructuredSession && currentSession?.id && structuredConnectionState === 'online') onSessionBusyChange?.(currentSession?.id, Boolean(structuredIsStreaming || structuredRequiresCleanup));
  }, [currentSession?.id, isStructuredSession, structuredConnectionState, structuredIsStreaming, structuredRequiresCleanup, onSessionBusyChange]);

  useEffect(() => () => {
    onAccessoryHeightChange?.(0);
  }, [onAccessoryHeightChange]);

  useEffect(() => {
    setConnectionState('connecting');
    setComposerSubmitting(false); composerRequestRef.current = null;
    setTerminalPreview('');
    setTerminalScreenSnapshot('');
    setIsTerminalPanelOpen(false);
    setTerminalRuntimeLatched(false);
    setIsTerminalBusy(false);
    setGitBranchInfo(null);
    setIsLoadingGitBranches(false);
    setIsSwitchingGitBranch(false);
    setTransportNotice('');
    setPlanMode(false);
    hasConnectedOnceRef.current = false;
    return () => { composerRequestRef.current = null; };
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
          setGitBranchInfo({ ...data, sessionId: currentSession.id });
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
    if (!currentSession?.id || !nextBranch || nextBranch === sessionGitBranchInfo?.currentBranch) return;
    setIsSwitchingGitBranch(true);
    try {
      const result = await checkoutSessionGitBranch(currentSession.id, nextBranch);
      if (result) {
        setGitBranchInfo({ ...result, sessionId: currentSession.id });
      }
    } finally {
      setIsSwitchingGitBranch(false);
    }
  }, [checkoutSessionGitBranch, currentSession?.id, sessionGitBranchInfo?.currentBranch]);

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

  const handleComposerSubmit = useCallback(async (text) => {
    if (attachmentDraftError || !validateAttachmentDraft()) return;
    if (!currentSession?.id || composerRequestRef.current || !environmentAllows(getActiveEnvironment(), isStructuredSession ? 'agentExecute' : 'terminalInput')) return;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const submittedAttachments = composerAttachments;
    const submittedDraftRevision = composerDraftRevision;
    const attachmentPaths = submittedAttachments.map(attachment => attachment?.path).filter(path => typeof path === 'string' && path.trim());
    const payload = isV4Session && userImages ? withAttachedFiles(typeof text === 'string' ? text : '', attachmentPaths)
      : isStructuredSession ? `${planMode && (isClaudeChat || isCodexSession) && (trimmed || attachmentPaths.length) ? PLAN_MARKER : ''}${withAttachedFiles(trimmed, attachmentPaths)}`
        : [attachmentPaths.join(' '), trimmed].filter(Boolean).join(' ').trim();
    if (!payload.trim() && !(isV4Session && userImages?.items.length)) return;
    const request = {};
    composerRequestRef.current = request;
    setComposerSubmitting(true);
    if ((isClaudeChat || isCodexSession) && serverQueue.status === 'available' && (structuredIsStreaming || serverQueue.snapshot?.order.length)) {
      try {
        const queued = await enqueueServerFollowup(currentSession.id, payload);
        if (composerRequestRef.current !== request) return;
        clearComposerDraft(submittedDraftRevision, trimmed);
        setComposerAttachments(current => current.filter(attachment => !submittedAttachments.includes(attachment)));
        serverQueue.refresh();
        setTransportNotice(queued.mode === 'held' ? 'Queued on the server. The queue is paused: open Queue to resume it.' : 'Queued on the server.');
      } catch (error) {
        if (composerRequestRef.current === request) setTransportNotice(error.message || 'Could not queue this message. Your draft was kept.');
      } finally {
        if (composerRequestRef.current === request) { composerRequestRef.current = null; setComposerSubmitting(false); }
      }
      return;
    }
    try {
      const result = isV4Session && userImages ? await sendImageDraft(payload)
        : isStructuredSession ? await structuredSendMessage(payload) : handleChatSend(payload);
      if (result?.completion) await result.completion;
      if (composerRequestRef.current !== request) return;
      if (isStructuredSession && result?.accepted !== true) {
        setTransportNotice('Message was not accepted. Your draft was kept.');
        return;
      }
      if (!result?.draftManaged) {
        clearComposerDraft(submittedDraftRevision, trimmed);
        setComposerAttachments(current => current.filter(attachment => !submittedAttachments.includes(attachment)));
      }
      setTransportNotice(result?.queued ? 'Terminal is still connecting. Command queued.' : '');
    } catch (error) {
      if (composerRequestRef.current === request) { setTransportNotice(error.message || 'Send failed. Your draft was kept.'); }
    } finally {
      if (composerRequestRef.current === request) { composerRequestRef.current = null; setComposerSubmitting(false); }
    }
  }, [attachmentDraftError, validateAttachmentDraft, composerAttachments, composerDraftRevision, clearComposerDraft, handleChatSend, isStructuredSession, isV4Session, isClaudeChat, isCodexSession, planMode, currentSession?.id, serverQueue, structuredIsStreaming, structuredSendMessage, userImages, sendImageDraft, setComposerAttachments]);

  const conversationActionsAllowed = sessionInputAllowed && !structuredHistoryOnly && structuredConnectionState === 'online'
    && !structuredIsStreaming && !structuredIsSending && !structuredIsInterrupting && !structuredRequiresCleanup && !pendingApproval;
  const handleEditMessage = useCallback(text => {
    if (typeof text !== 'string' || !text || !sessionInputAllowed) return;
    setComposerValue(current => current ? `${current}\n\n${text}` : text);
  }, [sessionInputAllowed, setComposerValue]);
  const handleImplementPlan = useCallback(async () => {
    if (!conversationActionsAllowed || composerRequestRef.current) return;
    const sessionId = currentSession?.id;
    const request = {};
    composerRequestRef.current = request;
    setComposerSubmitting(true);
    setPlanMode(false);
    try {
      const result = await structuredSendMessage('Implement the plan above.');
      if (composerRequestRef.current === request && result?.accepted !== true) setTransportNotice('The agent did not accept the request to implement the plan.');
    } catch (error) {
      if (composerRequestRef.current === request) setTransportNotice(error.message || 'Unable to implement the plan.');
    } finally {
      if (composerRequestRef.current === request && cwdSession.current.id === sessionId) { composerRequestRef.current = null; setComposerSubmitting(false); }
    }
  }, [conversationActionsAllowed, currentSession?.id, structuredSendMessage]);
  const handleStartThread = useCallback(async prompt => {
    if (!conversationActionsAllowed || !onSubmitPrompt || !sessionCwd || threadStartRequestRef.current) return;
    const request = {};
    const sessionId = currentSession.id;
    const signal = getEnvironmentSignal();
    const auth = captureAuthScope();
    threadStartRequestRef.current = request;
    try {
      await onSubmitPrompt(prompt, { path: sessionCwd, agentId: isCodexSession ? 'codex' : currentSession.aiType,
        selection: currentSession.model ? { model: currentSession.model, reasoning: currentSession.reasoning || '' } : undefined });
    } catch (error) {
      if (mountedRef.current && !signal.aborted && isAuthScopeCurrent(auth) && (cwdSession.current.id === sessionId || cwdSession.current.id === error?.sessionId)) setTransportNotice(error.message || 'Unable to start the new thread.');
    } finally {
      if (threadStartRequestRef.current === request) threadStartRequestRef.current = null;
    }
  }, [conversationActionsAllowed, onSubmitPrompt, sessionCwd, currentSession, isCodexSession]);

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

  const handleStructuredRawSend = useCallback(async data => {
    if (!currentSession?.id || !sendRawToSession) return;
    if (!['legacy', 'supervised'].includes(rawInputMode)) { setTransportNotice('Terminal input is unavailable or still being checked.'); return; }
    const sessionId = currentSession.id;
    const options = rawInputMode === 'supervised' ? { requireSupervision: true } : { requireLegacy: true };
    supervisedInputQueue(sessionId, text => sendRawToSession(sessionId, text, options), rawInputMode).enqueue(data);
  }, [currentSession?.id, sendRawToSession, rawInputMode]);

  const launchAiType = useCallback(async (aiTypeToLaunch, commandOverride = null) => {
    const origin = cwdSession.current;
    const environment = getEnvironmentSignal();
    const auth = captureAuthScope();
    const current = () => mountedRef.current && cwdSession.current === origin && !environment.aborted
      && isAuthScopeCurrent(auth) && environmentAllows(getActiveEnvironment(), 'terminalInput')
      && environmentAllows(getActiveEnvironment(), 'agentExecute');
    if (!currentSession?.id || isStructuredSession || !current()) return;
    try {
      const nextLaunchCommand = commandOverride || await resolveAgentLaunchCommand(aiTypeToLaunch, null, customAiProviders);
      if (!nextLaunchCommand || !current()) return;
      const result = handleChatSend(nextLaunchCommand);
      if (result?.completion) await result.completion;
      if (!current()) return;
      setTransportNotice(result?.queued ? 'Terminal is still connecting. Launch command queued.' : '');
    } catch (error) { if (current()) setTransportNotice(error.message || 'Unable to start this agent'); }
  }, [currentSession?.id, isStructuredSession, customAiProviders, handleChatSend]);

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
    <div className={`mobile-shell mobile-ui mobile-shell-parity${isStructuredSession ? ' mobile-shell-conversation' : ''}${isCodexSession ? ' mobile-shell-codex' : ''}`}>
      {showSessionStrip && sessions.length > 1 ? (
        <div className="mobile-shell-session-strip" role="tablist" aria-label="Sessions">
          {sessions.map((session) => {
            const isActive = session.id === currentSession?.id;
            const sessionState = sessionActivity[session.id];
            const isBusy = isActive && isStructuredSession ? structuredIsStreaming || structuredRequiresCleanup : sessionState?.isBusy;
            const statusLabel = isActive && isStructuredSession && structuredRequiresCleanup ? 'Cleanup required' : isBusy ? 'Running' : sessionState?.hasUnread ? 'Updated' : 'Ready';

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

      {isStructuredSession && structuredHistoryOnly && <p role="status" aria-label="Connection recovery" className="remote-readonly-notice">{structuredActionError}</p>}
      {isStructuredSession && (structuredIsInterrupting || structuredRequiresCleanup) && <p role="status" aria-label="Response cancellation" className="remote-readonly-notice">{structuredIsInterrupting ? 'Stopping response…' : sessionInputAllowed ? 'Cancellation is not confirmed. Retry cancellation before sending another message.' : 'Cancellation is not confirmed. Ask the session owner to retry cancellation before sending another message.'}</p>}
      {isStructuredSession && !structuredHistoryOnly && resolvedConnectionState !== 'online' && <p role="status" className="remote-readonly-notice">{resolvedConnectionState === 'unavailable' ? 'Conversation unavailable.' : resolvedConnectionState === 'offline' ? 'Conversation offline. Reconnecting…' : 'Connecting to conversation…'}</p>}
      {composerDraftError && composerDraftError !== structuredActionError && <p role="alert" className="remote-readonly-notice">{composerDraftError}</p>}
      {attachmentDraftError && <AttachmentDraftStatus error={attachmentDraftError} conflict={attachmentConflict} currentItems={composerAttachments} onRetry={retryAttachmentDraft} onUseSaved={useSavedAttachments} />}
      {restoredAttachments && !attachmentDraftError && <p role="status" className="remote-readonly-notice">Restored file selections. Check the files before sending; they may have changed.</p>}
      {modelUpdateError && <p role="alert" className="remote-readonly-notice">{modelUpdateError}</p>}
      <section className={`mobile-shell-stage mobile-shell-stage-parity${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
        {currentSession ? (
          <div className={`terminal-with-status mobile-terminal-shell${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
            <div className={`desktop-terminal-stack mobile-terminal-stack${isTerminalDockVisible ? ' terminal-panel-open' : ''}${useTerminalFirstLayout ? ' terminal-first' : ''}`}>
              {useConversationFirstLayout ? (
                <div className="desktop-conversation-surface mobile-conversation-surface">
                  <LazyDesktopConversationView
                    showHeader={false}
                    turns={isStructuredSession ? [] : turns}
                    isStreaming={isStructuredSession ? structuredIsStreaming : isTerminalBusy}
                    isLoadingHistory={!isStructuredSession && isConversationHistoryLoading}
                    onSend={sessionInputAllowed ? (isStructuredSession ? structuredSendMessage : handleChatSend) : undefined}
                    onSendRaw={!isManagedConversation && sessionInputAllowed ? (isStructuredSession ? handleStructuredRawSend : handleRawSend) : undefined}
                    onInterrupt={sessionInputAllowed ? (isStructuredSession ? structuredInterrupt : handleInterrupt) : undefined}
                    onImageUpload={!isV4Session ? handleImageUpload : undefined}
                    sessionId={currentSession.id}
                    aiType={currentAiType}
                    connectionState={resolvedConnectionState}
                    isSendReady={isStructuredSession ? structuredConnectionState === 'online' : isSendReady}
                    terminalPreview={terminalPreview}
                    terminalScreenSnapshot={terminalScreenSnapshot}
                    launchCommand={isStructuredSession ? '' : launchCommand}
                    launchQueued={false}
                    onLaunchAgent={!isStructuredSession && terminalInputAllowed && agentExecutionAllowed ? handleLaunchAgent : undefined}
                    onOpenTerminal={!isManagedConversation && (isStructuredSession || isTerminalBackedSession) ? handleOpenTerminalPanel : undefined}
                    conversationNotice={transportNotice}
                    showTerminalMirror={isTerminalDockVisible}
                    interactivePromptEvent={null}
                    isTerminalDockVisible={isTerminalDockVisible}
                    mode={isStructuredSession ? 'structured' : 'terminal'}
                    workspacePath={isStructuredSession ? sessionCwd : ''}
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
                    allowApprovalForSession={isCodexSession || (isStructuredSession && !isManagedConversation)}
                    onEditMessage={sessionInputAllowed ? handleEditMessage : undefined}
                    onImplementPlan={(isCodexSession || isClaudeChat) && conversationActionsAllowed ? handleImplementPlan : undefined}
                    onImplementPlanInNewThread={(isCodexSession || isClaudeChat) && conversationActionsAllowed && onSubmitPrompt && sessionCwd ? plan => handleStartThread(`Implement this plan:\n\n${plan}`) : undefined}
                    onForkFromMessage={(isCodexSession || isClaudeChat) && conversationActionsAllowed && onSubmitPrompt && sessionCwd ? handleStartThread : undefined}
                  />
                </div>
              ) : null}

              <div
                className={`desktop-terminal-slot mobile-terminal-slot${isTerminalDockVisible ? ' is-open' : ' is-collapsed'}${useTerminalFirstLayout ? ' terminal-first' : ''}`}
                aria-hidden={!isTerminalDockVisible ? 'true' : undefined}
              >
                <div className="desktop-terminal-runtime-host" data-persistent-terminal="" {...mainSelectionPress}>
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
                      isPrimary={visible && isTerminalDockVisible}
                      onRegisterImageUpload={(trigger) => {
                        imageInputRef.current = { click: trigger };
                      }}
                      onRegisterFocusTerminal={onRegisterFocusTerminal}
                      onConnectionChange={handleConnectionChange}
                      onCwdChange={handleCwdChange}
                      onActivityChange={handleActivityChange}
                      onOutputChunk={handleOutputChunk}
                      onScreenSnapshot={handleScreenSnapshot}
                      onRegisterSendText={handleRegisterSendText}
                      onRegisterSelectionActions={mainAddToChat.register}
                      onTurn={handleTurn}
                    />
                  ) : null}
                </div>
              </div>

              {isStructuredSession && threadTerminalOpen && <section className="mobile-thread-terminal" aria-label="Thread terminal" {...drawerSelectionPress}>
                {threadTerminal.terminals.length > 0 && <ThreadTerminalTabs className="mobile-thread-terminal-tabs" terminals={threadTerminal.terminals}
                  selectedId={threadTerminal.terminalId} onSelect={threadTerminal.select} onAdd={() => threadTerminal.addTerminal()}
                  disabled={!terminalInputAllowed} withPanels={false} />}
                {threadTerminal.createError && <div className="mobile-thread-terminal-error"><p role="alert">{threadTerminal.createError}</p>
                  {threadTerminal.canRetryCreate && <button type="button" aria-label="Retry adding terminal" disabled={!terminalInputAllowed} onClick={() => threadTerminal.retryCreate()}>Retry</button>}
                  <button type="button" aria-label="Dismiss terminal error" onClick={() => threadTerminal.dismissCreateError()}>Dismiss</button>
                  {threadTerminal.canStartAgainAfterReview && <button type="button" disabled={!terminalInputAllowed} onClick={() => threadTerminal.startAgainAfterReview()}>I checked the list; start another</button>}
                </div>}
                {threadTerminal.error ? <div className="mobile-thread-terminal-error"><p role="alert">{threadTerminal.error}</p>
                  {threadTerminal.canRetry && <button type="button" disabled={!terminalInputAllowed} onClick={() => threadTerminal.retry()}>Retry opening terminal</button>}
                  {!threadTerminal.terminalId && threadTerminal.canStartAgainAfterReview && <button type="button" disabled={!terminalInputAllowed} onClick={() => threadTerminal.startAgainAfterReview()}>I checked the list; start another</button>}
                </div>
                  : !sessionCwd ? <p role="status">This conversation has no workspace folder for a terminal.</p>
                    : !terminalInputAllowed && !threadTerminal.terminalId ? <p role="status">Terminal access is unavailable for this environment.</p>
                      : threadTerminal.terminalId ? <LazyTerminalChat
                        key={threadTerminal.terminalId}
                        surface="mobile"
                        sessionId={threadTerminal.terminalId}
                        keybarOpen={accessoryOpen}
                        viewportHeight={viewportHeight}
                        onUrlDetected={onUrlDetected}
                        fontSize={fontSize}
                        webglEnabled={webglEnabled}
                        viewMode="terminal"
                        inputEnabled={terminalInputAllowed}
                        isPrimary={visible}
                        onRegisterFocusTerminal={onRegisterFocusTerminal}
                        onRegisterSelectionActions={drawerAddToChat.register}
                      /> : <p role="status">Opening a terminal in this thread's folder…</p>}
              </section>}

              <DesktopStatusBar
                sessionId={currentSession.id}
                compactInputOptions
                composerSubmitLabel={isStructuredSession ? 'Send message' : undefined}
                sessionTitle={currentSession.title}
                sessionSummary={currentSession.thread?.topic || currentSession.title || ''}
                cwd={sessionCwd}
                gitBranch={isStructuredSession ? undefined : sessionGitBranchInfo?.currentBranch || matchingProjectInfo?.gitBranch}
                isActive={visible}
                voiceAvailable={visible && sessionInputAllowed}
                isTerminalPanelOpen={!useTerminalFirstLayout && isTerminalDockVisible}
                showTerminalToggle={!useTerminalFirstLayout && isStructuredSession && !isManagedConversation}
                onToggleTerminalPanel={!useTerminalFirstLayout && isStructuredSession && !isManagedConversation ? handleToggleTerminalPanel : undefined}
                terminalViewMode="terminal"
                showTerminalViewModeToggle={false}
                onToggleTerminalViewMode={undefined}
                connectionState={resolvedConnectionState}
                aiType={currentAiType}
                aiOptions={aiOptions}
                onSelectAiType={!isManagedConversation ? handleSelectAiType : undefined}
                showAiSelector={!isManagedConversation}
                onAddCustomAiCommand={handleAddCustomAiCommand}
                composerValue={composerValue}
                composerAttachments={composerAttachments}
                attachmentsEnabled={isV4Session || (environmentAllows(environment, 'fileWrite') && environmentAllows(environment, 'transfer'))}
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
                getAttachmentSelectionToken={getAttachmentSelectionToken}
                isAttachmentSelectionTokenCurrent={isAttachmentSelectionTokenCurrent}
                composerPlaceholder={sessionInputAllowed ? getComposerPlaceholder({ isStructuredSession, session: currentSession, foregroundAiType: currentAiType, customProviders: customAiProviders }) : 'Read-only remote session'}
                composerSubmitDisabled={Boolean(attachmentDraftError) || (isStructuredSession && structuredHistoryOnly)}
                isStreaming={isStructuredSession && structuredIsStreaming}
                isInterrupting={isStructuredSession && structuredIsInterrupting}
                requiresCleanup={isStructuredSession && structuredRequiresCleanup}
                onInterrupt={isStructuredSession && sessionInputAllowed ? structuredInterrupt : undefined}
                composerDisabled={!currentSession.id || !sessionInputAllowed || composerSubmitting || modelUpdatePending || (isStructuredSession && (structuredIsSending || structuredIsInterrupting))}
                runtimeInfo={isStructuredSession ? { label: `${getStructuredAgentLabel(currentSession)}${currentSession?.model ? ` · ${currentSession.model}` : ''}` } : runtimeInfo}
                gitBranches={sessionGitBranchInfo?.branches || []}
                currentGitBranch={isStructuredSession ? null : sessionGitBranchInfo?.currentBranch || matchingProjectInfo?.gitBranch || null}
                isLoadingGitBranches={isLoadingGitBranches}
                isSwitchingGitBranch={isSwitchingGitBranch}
                onSelectGitBranch={environmentAllows(environment, 'fileWrite') ? handleSelectGitBranch : undefined}
                composerPrimaryAction={(isCodexSession || isClaudeChat) && <MobileModelSettings key={`${environment?.id || ''}:${currentSession.id}`} agentId={isClaudeChat ? 'claude' : 'codex'}
                  disabled={modelChangeDisabled} pending={modelUpdatePending} error={modelUpdateError}
                  value={currentSession.model ? { model: currentSession.model, reasoning: currentSession.reasoning || '', ...(isCodexSession ? serviceTierEntry(currentSession.serviceTier) : {}) } : null}
                  onChange={handleSelectModel} />}
                composerSecondaryAction={<>
                  {(isCodexSession || isClaudeChat) && sessionInputAllowed && <button type="button" className={`mobile-plan-toggle${planMode ? ' active' : ''}`} aria-label="Plan mode" aria-pressed={planMode}
                    disabled={modelChangeDisabled} onClick={() => setPlanMode(value => !value)}>Plan mode: {planMode ? 'On' : 'Off'}</button>}
                  {(isV4Session || serverQueue.status === 'available') && <FollowupQueueButton sessionId={currentSession?.id} queue={serverQueue} />}
                  {isV4Session && <ConversationContextButton
                    sessionId={currentSession?.id} active={true}
                    controlState={structuredControlState}
                    onStopConversation={sessionInputAllowed ? structuredInterrupt : undefined}
                    isStopping={structuredIsInterrupting} stopError={structuredControlError}
                    requiresCleanup={structuredRequiresCleanup}
                    conversationBusy={Boolean(structuredIsStreaming || ['accepted', 'running'].includes(currentSession?.status))}
                    readOnly={!sessionInputAllowed}
                  />}
                </>}
              />
            </div>
          </div>
        ) : activeSessionId && !showWorkspaceStart ? (
          <p role="status" className="remote-readonly-notice">Selected conversation is loading or unavailable.</p>
        ) : (
          <WorkspaceStartView
            onSelectHistorySession={onSelectHistorySession}
            originThread={worktreeOrigin}
            currentPath={startWorkspacePath || projectInfo?.cwd || ''}
            projects={startProjects}
            recentFolders={recentFolders}
            onSelectWorkspace={onSelectWorkspace}
            onCreateSession={onCreateSession}
            onSubmitPrompt={onSubmitPrompt}
            onOpenImageConversation={onOpenImageConversation}
            onReviewImageConversation={onReviewImageConversation}
            onAddWorkspace={onAddWorkspace}
          />
        )}
      </section>

      {currentSession?.id && (isStructuredSession && threadTerminalOpen ? threadTerminal.terminalId : isTerminalDockVisible) && terminalInputAllowed ? (
        <MobileKeybar
          sessionId={isStructuredSession && threadTerminalOpen ? threadTerminal.terminalId : currentSession.id}
          isOpen={accessoryOpen}
          onHeightChange={onAccessoryHeightChange}
        />
      ) : null}

      {selectionMenu && <ContextMenu x={selectionMenu.x} y={selectionMenu.y} items={selectionMenu.items} onClose={closeSelectionMenu} />}

      {transportNotice && transportNotice !== structuredActionError ? (
        <div className="mobile-shell-launch-notice" role="status" aria-live="polite">
          {transportNotice}
        </div>
      ) : null}
    </div>
  );
}
