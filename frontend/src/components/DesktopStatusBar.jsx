import { useCallback, useEffect, useLayoutEffect, useMemo, useId, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { TerminalMicButton } from './TerminalMicButton';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { AI_TYPE_OPTIONS, getAiDisplayLabel } from '../utils/aiProviders';
import { uploadAttachment, uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { getComposerSlashSuggestions } from '../utils/slashCommands';
import { insertMention, mentionQuery, useFileMentions } from '../hooks/useFileMentions';
import { ContextChips } from './composer-context/ContextChips';
import { addContext, buildPullRequestContext, buildThreadContext, joinContext, redactContextBlocks, removeContext, splitContext } from './composer-context/composerContext';
import { readPromptHistory, recordPrompt, stepPromptHistory } from './composer-context/promptHistory';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentCacheScope, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { getComposerScrollPreference, subscribeComposerScrollPreference } from '../utils/composerScrollPreference';
import { createTransferReviewStore } from '../utils/transferReviewStore';
import { createLargePasteRecovery, hasLargePasteRecoveryHistory } from '../utils/largePasteRecovery';
import { createUuid } from '../utils/createUuid';
import { ProviderAuthModal } from './ProviderAuthModal';
import { UserImageAttachments } from './UserImageAttachments';
import './UserImageAttachments.css';
import './DesktopComposer.css';

const IMAGE_INPUT_ACCEPT = [
  'image/*',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
  '.bmp'
].join(',');

const OWNED_IMAGE_INPUT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp';
const SCREENSHOT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/bmp']);
const LARGE_PASTE_BYTES = 32 * 1024;
const getAuthScopeKey = () => JSON.stringify(captureAuthScope());

function suppliedFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  if (files.length) return files;
  return Array.from(dataTransfer?.items || []).filter(item => item?.kind === 'file' && typeof item.getAsFile === 'function')
    .map(item => item.getAsFile()).filter(Boolean);
}

function containsDroppedFolder(dataTransfer) {
  return Array.from(dataTransfer?.items || []).some(item => item?.kind === 'file'
    && typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory);
}

// DOM textarea selection counts CRLF as one character; draft text keeps its bytes.
function rawTextOffset(text, domOffset) {
  let index = 0;
  for (let count = 0; count < domOffset && index < text.length; count += 1) {
    index += text[index] === '\r' && text[index + 1] === '\n' ? 2 : 1;
  }
  return index;
}

/**
 * Desktop status bar at the bottom of the terminal pane.
 * Shows connection status, current directory, git branch, and action buttons.
 */
const NO_SKILLS = [];
const NO_MENTIONS = [];

export function DesktopStatusBar({
  sessionId,
  compactConversation = false,
  compactInputOptions = false,
  cwd,
  gitBranch,
  isActive = false,
  isTerminalPanelOpen = false,
  showTerminalToggle = true,
  onToggleTerminalPanel,
  terminalViewMode = 'codex',
  showTerminalViewModeToggle = false,
  onToggleTerminalViewMode,
  aiType = null,
  aiOptions = AI_TYPE_OPTIONS,
  customAiProviders = [],
  skills = NO_SKILLS,
  mentionRoot = '',
  allowAnyFile = false,
  composerDraftStore,
  mentionFiles: providedMentionFiles,
  mentionThreads = NO_MENTIONS,
  mentionPullRequests = NO_MENTIONS,
  onSelectAiType,
  onAddCustomAiCommand,
  composerValue = '',
  composerAttachments = [],
  attachmentsEnabled = true,
  attachmentsDisabledMessage = 'Attachments are not supported in this conversation yet.',
  userImages = null,
  onComposerChange,
  onComposerSubmit,
  onComposerAttachmentAdd,
  onComposerAttachmentRemove,
  waitForAttachmentPersistence,
  getAttachmentSelectionToken,
  isAttachmentSelectionTokenCurrent,
  runtimeInfo = null,
  gitBranches = [],
  currentGitBranch = null,
  isLoadingGitBranches = false,
  isSwitchingGitBranch = false,
  onSelectGitBranch,
  composerPlaceholder = 'Send a command or prompt',
  composerDisabled = false,
  voiceAvailable = true,
  composerSubmitDisabled = false,
  composerSubmitLabel = 'Send to terminal',
  isStreaming = false,
  isInterrupting = false,
  requiresCleanup = false,
  onInterrupt,
  showTopRow = null,
  showComposerFooter = null,
  showImageButton = true,
  showAiSelector = true,
  showAutocorrectToggle = true,
  showMicButtons = true,
  composerPrimaryAction = null,
  composerSecondaryAction = null,
  composerContext = null,
}) {
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const isMobile = useMobileDetect();
  const mobilePasteMenu = isMobile && !userImages && allowAnyFile && attachmentsEnabled && Boolean(composerDraftStore);
  const collapseOnScroll = useSyncExternalStore(subscribeComposerScrollPreference, getComposerScrollPreference, () => true);
  const composerInputRef = useRef(null);
  const composerShellRef = useRef(null);
  const [scrollCompact, setScrollCompact] = useState(false);
  const pendingComposerSelection = useRef(null);
  const [composerSelection, setComposerSelection] = useState(null);
  const transcriptDraftRef = useRef(null);
  transcriptDraftRef.current = { sessionId, composerValue, onComposerChange };
  const { chips: contextChips, text: draftText } = splitContext(composerValue);
  const setDraftText = (next) => onComposerChange?.(joinContext(contextChips, next));
  const historyIndexRef = useRef(-1);
  const historyRecalledRef = useRef('');
  useEffect(() => { historyIndexRef.current = -1; setComposerSelection(null); pendingComposerSelection.current = null; }, [sessionId]);
  const isContextUnavailable = (chip) => (chip.kind === 'thread' ? !mentionThreads.some(thread => thread.id === chip.id)
    : chip.kind === 'pr' ? !mentionPullRequests.some(pr => pr.id === chip.id) : false);
  const contextTriggerRef = useRef(null);
  const contextPanelRef = useRef(null);
  const composerActionsRef = useRef(null);
  const contextId = useId();
  const [contextOpen, setContextOpen] = useState(false);
  // The supplied mobile model control owns its trigger; keep its full selection in the accessible name.
  useLayoutEffect(() => {
    if (!compactInputOptions) return undefined;
    const trigger = composerActionsRef.current?.querySelector('.mobile-model-trigger');
    const model = trigger?.querySelector('span:nth-child(2)');
    if (!trigger || !model) return undefined;
    const originalLabel = trigger.getAttribute('aria-label');
    const updateLabel = () => trigger.setAttribute('aria-label', `${originalLabel || 'Model settings'}: ${model.textContent}`);
    updateLabel();
    const observer = new MutationObserver(updateLabel);
    observer.observe(model, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (originalLabel === null) trigger.removeAttribute('aria-label');
      else trigger.setAttribute('aria-label', originalLabel);
    };
  }, [compactInputOptions, composerPrimaryAction]);
  useLayoutEffect(() => {
    if (!contextOpen) return undefined;
    const panel = contextPanelRef.current;
    const trigger = contextTriggerRef.current;
    if (!panel || !trigger) return undefined;
    const measure = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = Math.min(320, width - 24);
      panel.style.width = `${panelWidth}px`;
      panel.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - panelWidth - 12))}px`;
      panel.style.maxHeight = `${Math.max(44, rect.top - top - 20)}px`;
      panel.style.top = `${Math.max(top + 12, rect.top - panel.getBoundingClientRect().height - 8)}px`;
    };
    const dismissOutside = event => {
      if (!panel.contains(event.target) && !trigger.contains(event.target)) setContextOpen(false);
    };
    measure();
    panel.focus();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [contextOpen]);
  useEffect(() => { setContextOpen(false); }, [sessionId]);
  const composerOptionsRef = useRef(null);
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [voiceStates, setVoiceStates] = useState({});
  const handleDirectVoiceState = useCallback(state => setVoiceStates(current => ({ ...current, direct: state })), []);
  const handleLocalVoiceState = useCallback(state => setVoiceStates(current => ({ ...current, local: state })), []);
  const handleGroqVoiceState = useCallback(state => setVoiceStates(current => ({ ...current, groq: state })), []);
  const currentVoiceStates = showMicButtons ? Object.entries(voiceStates).filter(([key, state]) => state.sessionId === sessionId && (key !== 'direct' || compactInputOptions)) : [];
  const activeVoice = currentVoiceStates.find(([, state]) => state.isChecking || state.isRequesting || state.isRecording || state.isTranscribing);
  const voiceBusy = Boolean(activeVoice);
  const [voiceInterruptions, setVoiceInterruptions] = useState({});
  const previousVoiceOwner = useRef({ sessionId, voiceAvailable });
  useLayoutEffect(() => {
    const previous = previousVoiceOwner.current;
    if ((previous.sessionId !== sessionId || (previous.voiceAvailable && !voiceAvailable))
      && Object.values(voiceStates).some(state => state.sessionId === previous.sessionId && (state.isChecking || state.isRequesting || state.isRecording || state.isTranscribing))) {
      setVoiceInterruptions(current => ({ ...current, [previous.sessionId]: true }));
    }
    previousVoiceOwner.current = { sessionId, voiceAvailable };
  }, [sessionId, voiceAvailable, voiceStates]);
  useLayoutEffect(() => {
    const details = composerOptionsRef.current;
    if (!composerOptionsOpen || !details) return undefined;
    const measure = () => {
      const menu = details.querySelector('.composer-input-options-menu');
      const trigger = details.querySelector('summary');
      if (!menu || !trigger) return;
      const viewport = window.visualViewport;
      const header = document.querySelector('.mobile-header');
      const top = Math.max(viewport?.offsetTop || 0, header?.getBoundingClientRect().bottom || 0);
      const left = viewport?.offsetLeft || 0;
      const width = viewport?.width || window.innerWidth;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = Math.min(280, width - 24);
      menu.style.position = 'fixed';
      menu.style.width = `${menuWidth}px`;
      menu.style.bottom = 'auto';
      menu.style.right = 'auto';
      menu.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - menuWidth - 12))}px`;
      menu.style.maxHeight = `${Math.max(44, Math.floor(rect.top - top - 10))}px`;
      menu.style.top = `${Math.max(top + 8, rect.top - menu.getBoundingClientRect().height - 8)}px`;
    };
    const dismissOutside = event => {
      if (!details.contains(event.target) && !event.target.closest?.('[role="dialog"], .modal-overlay')) {
        details.open = false;
        setComposerOptionsOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (details.parentElement) observer?.observe(details.parentElement);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [composerOptionsOpen]);
  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    if (pendingComposerSelection.current?.text === draftText) {
      const { position } = pendingComposerSelection.current;
      pendingComposerSelection.current = null;
      input.focus();
      input.setSelectionRange(position, position);
      setComposerSelection({ value: input.value, start: position, end: position });
    }
  }, [draftText, isMobile]);
  const {
    handleKeyDown: autocorrectKeyDown,
    handleSelectionChange: handleAutocorrectSelectionChange
  } = useAutocorrectInput(
    draftText,
    (nextValue) => setDraftText(typeof nextValue === 'function' ? nextValue(draftText) : nextValue),
    autocorrectEnabled
  );
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [isProviderAuthOpen, setIsProviderAuthOpen] = useState(false);
  const [isPastingImage, setIsPastingImage] = useState(false);
  const [isPreparingLegacyImage, setIsPreparingLegacyImage] = useState(false);
  const legacyImageWorkRef = useRef(null);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [pasteNotice, setPasteNotice] = useState(null);
  const pasteAsTextUntil = useRef(0);
  const pasteNextAsTextRef = useRef(null);
  const [pasteNextAsTextView, setPasteNextAsTextView] = useState(null);
  const [transferReviewView, setTransferReviewView] = useState(null);
  const transferReviewRef = useRef(null);
  const transferReviewMarkerRef = useRef(null);
  const activeTransfersRef = useRef(new Map());
  const largeTransfersRef = useRef(new Set());
  const [, setActiveTransferRevision] = useState(0);
  const [transferReviewStorageError, setTransferReviewStorageError] = useState(false);
  const requireTransferReview = (view, existingId = null) => {
    if (view !== pickerViewRef.current) return;
    if (transferReviewRef.current !== view) {
      const id = existingId && transferReviewStore.status(existingId) === 'present' ? existingId : transferReviewStore.mark();
      transferReviewMarkerRef.current = { view, id };
      setTransferReviewStorageError(!id);
    }
    transferReviewRef.current = view;
    setTransferReviewView(view);
  };
  const [ownedImageWorkView, setOwnedImageWorkView] = useState(null);
  const ownedImageWorkRef = useRef(null);
  const [imageActionError, setImageActionError] = useState(null);
  const [largePasteReview, setLargePasteReview] = useState(null);
  const [largePasteRevision, setLargePasteRevision] = useState(0);
  const largePasteAction = useRef(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const aiMenuRef = useRef(null);
  const imageInputRef = useRef(null);
  const [restoreOpening, setRestoreOpening] = useState(null);
  const pickerSequence = useRef(0);
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const authScopeKey = useSyncExternalStore(subscribeAuth, getAuthScopeKey);
  const transferReviewStore = useMemo(() => createTransferReviewStore({ sessionId, auth: JSON.parse(authScopeKey), environment: getEnvironmentCacheScope(), signal: environmentSignal }), [sessionId, authScopeKey, environmentSignal]);
  const transferReviewSnapshot = useSyncExternalStore(transferReviewStore.subscribe, transferReviewStore.getSnapshot, () => '[]');
  const allTransferRecords = transferReviewSnapshot === 'unavailable' ? [] : JSON.parse(transferReviewSnapshot);
  const pickerView = useMemo(() => ({}), [sessionId, userImages?.scopeKey, userImages?.generation, environmentSignal, authScopeKey]);
  const pickerViewRef = useRef(pickerView), pickerLeaseRef = useRef(null);
  if (pickerViewRef.current !== pickerView) { pickerLeaseRef.current = null; pickerViewRef.current = pickerView; }
  const displayedTransferReviews = allTransferRecords.filter(id => activeTransfersRef.current.get(id) !== pickerView);
  const localReview = transferReviewView === pickerView;
  const localReviewId = transferReviewMarkerRef.current?.view === pickerView ? transferReviewMarkerRef.current.id : null;
  const otherTransferReviews = displayedTransferReviews.filter(id => id !== localReviewId);
  const genericTransferReviews = displayedTransferReviews.filter(id => transferReviewStore.kind(id) !== 'large-paste');
  const reviewedMarker = localReview ? localReviewId : displayedTransferReviews[0];
  const reviewingLargePaste = reviewedMarker && transferReviewStore.kind(reviewedMarker) === 'large-paste';
  const discoveryAuth = JSON.parse(authScopeKey), discoveryEnvironment = getEnvironmentCacheScope();
  const discoveryScope = [discoveryAuth.userId, discoveryAuth.home, JSON.stringify([discoveryEnvironment.identity, discoveryEnvironment.environment]), sessionId];
  const recoveryDiscovery = Boolean(discoveryAuth.userId && sessionId && composerDraftStore && (globalThis.indexedDB || hasLargePasteRecoveryHistory(discoveryScope)));
  const currentLargeReview = largePasteReview?.view === pickerView ? largePasteReview : null;
  const recoveryHold = recoveryDiscovery && (!currentLargeReview || ['loading', 'ready', 'missing', 'unavailable'].includes(currentLargeReview.state));
  const requiresTransferReview = localReview || displayedTransferReviews.length > 0 || transferReviewSnapshot === 'unavailable' || recoveryHold;
  const hasTransferReview = () => {
    if (recoveryHold) return true;
    if (transferReviewRef.current === pickerViewRef.current) return true;
    const snapshot = transferReviewStore.getSnapshot();
    return snapshot === 'unavailable' ? true
      : JSON.parse(snapshot).some(id => activeTransfersRef.current.get(id) !== pickerViewRef.current);
  };
  function beginTransfer(view, kind = 'generic') {
    if (view !== pickerViewRef.current) return null;
    let id;
    try { id = createUuid(); } catch { id = null; }
    if (id) activeTransfersRef.current.set(id, view);
    if (id && kind === 'large-paste') largeTransfersRef.current.add(id);
    if (!id || !transferReviewStore.mark(id, kind)) {
      if (id) activeTransfersRef.current.delete(id);
      if (id) largeTransfersRef.current.delete(id);
      const message = 'Could not save file selection recovery. No files were uploaded; check device storage.';
      if (imageViewRef.current.userImages) setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message });
      else setUploadError(message);
      requireTransferReview(view);
      return null;
    }
    setActiveTransferRevision(value => value + 1);
    return id;
  }
  function finishTransfer(view, id, success) {
    if (!id) return;
    activeTransfersRef.current.delete(id);
    const large = largeTransfersRef.current.delete(id);
    if (!mountedRef.current || view !== pickerViewRef.current) return;
    if (success && transferReviewStore.status(id) === 'present' && transferReviewStore.clear([id])) {
      setActiveTransferRevision(value => value + 1);
      return;
    }
    if (success || transferReviewRef.current !== view) {
      const message = success ? 'File selection review changed or could not be saved. Check the current files before continuing.' : 'File selection did not finish. Check the current files before continuing.';
      if (imageViewRef.current.userImages) setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message });
      else setUploadError(message);
    }
    if (large && transferReviewStore.status(id) === 'missing') transferReviewStore.mark(id, 'large-paste');
    requireTransferReview(view, id);
    setActiveTransferRevision(value => value + 1);
  }
  const ownedImageWorkPending = ownedImageWorkView === pickerView;
  const imageViewRef = useRef(null);
  const mountedRef = useRef(true);
  const compositionRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    setIsPastingImage(false); setUploadError(''); setPasteNotice(null); setIsImageDragOver(false); setTransferReviewStorageError(false);
    pasteAsTextUntil.current = 0;
    pasteNextAsTextRef.current = null; setPasteNextAsTextView(null);
    setIsPreparingLegacyImage(Boolean(legacyImageWorkRef.current?.view === pickerView && legacyImageWorkRef.current.pending > 0));
    compositionRef.current = false;
  }, [pickerView]);
  function pasteRecovery(view) {
    const auth = JSON.parse(authScopeKey), environment = getEnvironmentCacheScope();
    if (!auth.userId || !sessionId) return null;
    return createLargePasteRecovery({ scope: [auth.userId, auth.home, JSON.stringify([environment.identity, environment.environment]), sessionId], signal: environmentSignal,
      isCurrent: () => getEnvironmentSignal() === environmentSignal && isAuthScopeCurrent(auth) });
  }
  useEffect(() => transferReviewStore.subscribe(() => setLargePasteRevision(value => value + 1)), [transferReviewStore]);
  useEffect(() => {
    const refresh = () => setLargePasteRevision(value => value + 1);
    let channel;
    try { if (globalThis.BroadcastChannel) { channel = new BroadcastChannel('terminal-v4-large-paste-changed'); channel.onmessage = refresh; } } catch { /* Focus refresh remains available. */ }
    window.addEventListener('tv4:large-paste-recovery-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { channel?.close(); window.removeEventListener('tv4:large-paste-recovery-changed', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const largePasteMarker = displayedTransferReviews.find(id => transferReviewStore.kind(id) === 'large-paste');
  useEffect(() => {
    if (!largePasteMarker && !recoveryDiscovery) { setLargePasteReview(null); return undefined; }
    const view = pickerView, marker = largePasteMarker;
    let active = true, store;
    setLargePasteReview({ view, marker, state: 'loading' });
    try { store = pasteRecovery(view); }
    catch { setLargePasteReview({ view, marker, state: 'unavailable' }); return undefined; }
    if (!store) { setLargePasteReview({ view, marker, state: 'unavailable' }); return undefined; }
    store.read().then(record => {
      if (!active || view !== pickerViewRef.current) return;
      if (!record) { setLargePasteReview({ view, marker, state: marker ? 'missing' : 'clear' }); return; }
      if (activeTransfersRef.current.get(record.id) === view) { setLargePasteReview({ view, marker: record.id, state: 'active' }); return; }
      if (transferReviewStore.status(record.id) === 'missing') transferReviewStore.mark(record.id, 'large-paste');
      setLargePasteReview({ view, marker: record.id, state: 'ready', record });
    }).catch(() => { if (active && view === pickerViewRef.current) setLargePasteReview({ view, marker, state: 'unavailable' }); })
      .finally(() => store.close());
    return () => { active = false; store.close(); };
  }, [largePasteMarker, largePasteRevision, pickerView, authScopeKey, environmentSignal, recoveryDiscovery]);
  imageViewRef.current = { userImages, sessionId, disabled: composerDisabled, attachmentsEnabled, attachmentsDisabledMessage, onComposerAttachmentAdd, waitForAttachmentPersistence, composerAttachments };
  const pickerBinding = useMemo(() => ({}), [pickerView, userImages?.pendingPreviousSend?.requestId, userImages?.pendingPreviousSend?.originalsRevision]);
  const pickerBindingRef = useRef(pickerBinding);
  if (pickerBindingRef.current !== pickerBinding) { pickerLeaseRef.current = null; pickerBindingRef.current = pickerBinding; }
  const currentRestoreOpening = restoreOpening?.binding === pickerBinding ? restoreOpening : null;
  const imageItems = Array.isArray(userImages?.items) ? userImages.items : [];
  let imageScopeMatches = false;
  try { imageScopeMatches = Boolean(userImages && JSON.parse(userImages.scopeKey)?.[3] === sessionId); } catch { /* Invalid controller scope stays disabled. */ }
  const canAddUserImages = Boolean(userImages && imageScopeMatches && !composerDisabled && userImages.canAdd
    && userImages.admission?.state === 'allowed' && !userImages.isHydrating && !userImages.isSaving);
  const canSendUserImages = Boolean(userImages && imageScopeMatches && userImages.canSend && !userImages.isHydrating && !userImages.isSaving
    && !userImages.pendingPreviousSend && Array.isArray(userImages.items) && imageItems.every(item => item.status === 'ready')
    && (!imageItems.length || userImages.admission?.state === 'allowed') && composerAttachments.length === 0);
  const currentImageError = userImages && imageScopeMatches && imageActionError?.scopeKey === userImages.scopeKey && imageActionError?.generation === userImages.generation
    ? imageActionError.message : '';

  function sameImageView(view) {
    const live = imageViewRef.current;
    return Boolean(view && live.sessionId === sessionId && live.userImages?.scopeKey === view.scopeKey && live.userImages?.generation === view.generation);
  }

  function sameOriginalRow(request) {
    const live = imageViewRef.current, previous = live.userImages?.pendingPreviousSend;
    return Boolean(sameImageView(userImages) && !live.disabled && imageScopeMatches && previous?.originalsCanChoose
      && previous.requestId === request?.requestId && previous.originalsRevision === request?.originalsRevision
      && Number.isSafeInteger(request.slot) && previous.originals?.some(item => item.slot === request.slot));
  }
  function openOriginalPicker(request) {
    if (!sameOriginalRow(request)) return;
    const opening = { id: ++pickerSequence.current, view: pickerViewRef.current, binding: pickerBindingRef.current,
      purpose: 'restore_original', request: { requestId: request.requestId, originalsRevision: request.originalsRevision, slot: request.slot }, node: null };
    pickerLeaseRef.current = null; setImageActionError(null);
    // Commit this opening's one connected input before click(), in the same
    // trusted button handler. A timer/effect would lose the chooser gesture.
    flushSync(() => setRestoreOpening(opening));
    if (!sameOriginalRow(opening.request) || opening.view !== pickerViewRef.current || opening.binding !== pickerBindingRef.current) return;
    opening.node = imageInputRef.current;
    if (!opening.node?.isConnected) return;
    pickerLeaseRef.current = opening; opening.node.click();
  }

  async function imageAction(action, ...args) {
    if (action === 'chooseOriginalImage') { openOriginalPicker(args[0]); return; }
    const view = userImages, actionView = pickerViewRef.current;
    if (!sameImageView(view) || imageViewRef.current.disabled || !imageScopeMatches) return false;
    setImageActionError(null);
    try {
      if (typeof view[action] !== 'function') throw new Error('This image action is unavailable.');
      await view[action](...args);
      return true;
    } catch (error) {
      if (mountedRef.current && actionView === pickerViewRef.current && sameImageView(view)) {
        setImageActionError({ scopeKey: view.scopeKey, generation: view.generation,
          message: String(error?.message || 'Image action failed. Your draft was kept.').slice(0, 400) });
        if (action === 'addFiles') requireTransferReview(actionView, ownedImageWorkRef.current?.transferId);
      }
      return false;
    }
  }

  async function addOwnedFiles(files, source) {
    if (!sameImageView(userImages) || !imageScopeMatches) return;
    if (!canAddUserImages) {
      setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message: 'The selected images could not be added. Check image availability before continuing.' });
      requireTransferReview(pickerViewRef.current);
      return;
    }
    if (!files.length) {
      setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message: 'Choose PNG, JPEG, GIF or WebP image files to attach.' });
      requireTransferReview(pickerViewRef.current);
      return;
    }
    const view = pickerViewRef.current;
    if (ownedImageWorkRef.current?.view === view && ownedImageWorkRef.current.pending > 0) {
      setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message: 'Wait for the current image selection to finish before attaching more files.' });
      requireTransferReview(view);
      return;
    }
    const transferId = beginTransfer(view);
    if (!transferId) return;
    const work = { view, pending: 0, transferId };
    work.pending += 1;
    ownedImageWorkRef.current = work;
    setOwnedImageWorkView(view);
    let success = false;
    try { success = await imageAction('addFiles', files, { source }); }
    finally {
      finishTransfer(view, transferId, success);
      work.pending -= 1;
      if (mountedRef.current && ownedImageWorkRef.current === work && work.view === pickerViewRef.current && work.pending === 0) setOwnedImageWorkView(null);
    }
  }

  const selectedAiOption = aiOptions.find((option) => option.id === aiType)
    ?? (aiType ? { id: aiType, label: getAiDisplayLabel(aiType), color: 'var(--accent-info)' } : null)
    ?? aiOptions[0]
    ?? AI_TYPE_OPTIONS[0];
  const resolvedShowTopRow = typeof showTopRow === 'boolean'
    ? showTopRow
    : Boolean(showTerminalToggle || showTerminalViewModeToggle);
  const resolvedTerminalViewMode = terminalViewMode === 'terminal' ? 'terminal' : 'codex';
  const isCodexViewMode = resolvedTerminalViewMode === 'codex';
  const isRawTerminalViewMode = resolvedTerminalViewMode === 'terminal';
  const resolvedShowComposerFooter = typeof showComposerFooter === 'boolean'
    ? showComposerFooter
    : Boolean(cwd || runtimeInfo?.label || currentGitBranch || gitBranch || gitBranches.length);
  const activeRuntimeProviderId = runtimeInfo?.providerId ?? aiType ?? null;
  const hasMentionSources = Boolean(mentionRoot) || mentionThreads.length > 0 || mentionPullRequests.length > 0;
  const normalizedDraft = draftText.replace(/\r\n?/g, '\n');
  const currentSelection = composerSelection?.value === normalizedDraft ? composerSelection : null;
  const cursor = currentSelection ? rawTextOffset(draftText, currentSelection.start) : draftText.length;
  const mentionPrefix = draftText.slice(0, cursor);
  const mentionSuffix = draftText.slice(cursor).replace(/^[^\s@]*/, '');
  const activeMention = hasMentionSources && (!currentSelection || currentSelection.start === currentSelection.end)
    ? mentionQuery(mentionPrefix) : null;
  const fetchedMentionFiles = useFileMentions(providedMentionFiles ? '' : mentionRoot, activeMention);
  const mentionFiles = providedMentionFiles ?? fetchedMentionFiles;
  const slashSuggestions = useMemo(
    () => {
      if (activeMention == null) return getComposerSlashSuggestions(draftText, activeRuntimeProviderId, customAiProviders, skills);
      const needle = activeMention.toLowerCase();
      const withoutQuery = mentionPrefix.replace(/@[^\s@]*$/, '');
      const remainingText = withoutQuery + (withoutQuery.endsWith(' ') && mentionSuffix.startsWith(' ') ? mentionSuffix.slice(1) : mentionSuffix);
      const references = [
        ...mentionThreads.map(thread => ({ desc: 'Thread', chip: buildThreadContext(thread) })),
        ...mentionPullRequests.map(pr => ({ desc: 'Pull request', chip: buildPullRequestContext(pr) })),
      ].filter(({ chip }) => chip && (chip.label.toLowerCase().includes(needle) || chip.id.toLowerCase().includes(needle))).slice(0, 8)
        .map(({ chip, desc }) => ({ key: `${chip.kind}:${chip.id}`, cmd: `@${chip.label}`, desc, insert: addContext(joinContext(contextChips, remainingText), chip), cursor: withoutQuery.length }));
      const files = mentionFiles.map(file => {
        let inserted = insertMention(mentionPrefix, file);
        if (/^\s/.test(mentionSuffix)) inserted = inserted.slice(0, -1);
        return { cmd: `@${file}`, desc: 'File', insert: joinContext(contextChips, inserted + mentionSuffix), cursor: inserted.length };
      });
      return [...references, ...files];
    },
    [activeMention, activeRuntimeProviderId, composerValue, cursor, customAiProviders, mentionFiles, mentionThreads, mentionPullRequests, skills]
  );

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [draftText, cursor, slashSuggestions.length]);

  function insertSuggestion(suggestion) {
    const value = activeMention != null && suggestion.insert != null
      ? suggestion.insert : joinContext(contextChips, suggestion.insert ?? `${suggestion.cmd} `);
    if (typeof suggestion.cursor === 'number') {
      const text = splitContext(value).text;
      pendingComposerSelection.current = { text, position: text.slice(0, suggestion.cursor).replace(/\r\n?/g, '\n').length };
    }
    onComposerChange?.(value);
  }

  useEffect(() => {
    if (!isAiMenuOpen) return undefined;
    const selected = aiMenuRef.current?.querySelector('[aria-checked="true"]')
      || aiMenuRef.current?.querySelector('[role="menuitemradio"], [role="menuitem"]');
    selected?.focus();

    function handleOutsideClick(event) {
      if (aiMenuRef.current && !aiMenuRef.current.contains(event.target)) {
        setIsAiMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isAiMenuOpen]);

  function handleAiMenuKeyDown(event) {
    if (event.key === 'Escape' && isAiMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setIsAiMenuOpen(false);
      aiMenuRef.current?.querySelector('.status-ai-selector')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isAiMenuOpen) { setIsAiMenuOpen(true); return; }
    const items = [...aiMenuRef.current.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function handleAiTypeSelect(nextAiType) {
    onSelectAiType?.(nextAiType);
    setIsAiMenuOpen(false);
    aiMenuRef.current?.querySelector('.status-ai-selector')?.focus();
  }

  function handleAddCustomCommand() {
    const label = window.prompt('Name this custom AI command');
    if (typeof label !== 'string' || !label.trim()) return;

    const command = window.prompt(`Launch command for ${label.trim()}`);
    if (typeof command !== 'string' || !command.trim()) return;

    onAddCustomAiCommand?.(label.trim(), command.trim());
    setIsAiMenuOpen(false);
  }

  function handleComposerSubmit(event, submittedValue = composerValue) {
    if (event?.type === 'submit' && event.target !== event.currentTarget) return;
    event?.preventDefault?.();
    if (composerDisabled || composerSubmitDisabled || isInterrupting || requiresCleanup || voiceBusy || hasTransferReview()
      || ownedImageWorkRef.current?.view === pickerViewRef.current && ownedImageWorkRef.current.pending > 0) return;
    if (splitContext(typeof submittedValue === 'string' ? submittedValue : '').chips.some(isContextUnavailable)) {
      setUploadError('Remove unavailable thread or pull request references before sending.');
      return;
    }
    if (typeof submittedValue === 'string') submittedValue = redactContextBlocks(submittedValue);
    if (!userImages && (isPreparingLegacyImage || legacyImageWorkRef.current?.view === pickerViewRef.current && legacyImageWorkRef.current.pending > 0)) return;
    if (userImages) {
      if (!canSubmitComposer || !sameImageView(userImages)) return;
      recordPrompt(sessionId, submittedValue);
      onComposerSubmit?.(typeof submittedValue === 'string' ? submittedValue : '');
      return;
    }
    if (!attachmentsEnabled && composerAttachments.length) { setUploadError('Remove attachments before sending this conversation.'); return; }
    const nextValue = typeof submittedValue === 'string' ? submittedValue : '';
    if (!nextValue.trim() && composerAttachments.length === 0) return;
    recordPrompt(sessionId, nextValue);
    historyIndexRef.current = -1;
    onComposerSubmit?.(nextValue);
  }

  function handleTerminalViewModeSelect(nextMode) {
    if (nextMode === resolvedTerminalViewMode) return;
    onToggleTerminalViewMode?.(nextMode);
  }

  function handleComposerTranscript(transcribedText) {
    const draft = transcriptDraftRef.current;
    if (draft.sessionId !== sessionId || typeof draft.onComposerChange !== 'function') return;
    const normalizedTranscript = typeof transcribedText === 'string' ? transcribedText.trim() : '';
    if (!normalizedTranscript) return;

    const needsSeparator = Boolean(draft.composerValue) && !/\s$/.test(draft.composerValue);
    draft.onComposerChange(`${draft.composerValue}${needsSeparator ? ' ' : ''}${normalizedTranscript}`);
  }

  function captureLegacyImageScope() {
    return { view: pickerViewRef.current, environment: getEnvironmentSignal(), auth: captureAuthScope(),
      selectionToken: getAttachmentSelectionToken?.(), selectionCurrent: isAttachmentSelectionTokenCurrent };
  }

  function isLegacyImageScopeCurrent(scope) {
    return mountedRef.current && scope.view === pickerViewRef.current && !scope.environment.aborted
      && isAuthScopeCurrent(scope.auth) && !imageViewRef.current.userImages;
  }

  function beginLegacyImageWork(scope) {
    const work = legacyImageWorkRef.current?.view === scope.view ? legacyImageWorkRef.current : { view: scope.view, pending: 0 };
    work.pending += 1;
    legacyImageWorkRef.current = work;
    setIsPreparingLegacyImage(true);
    return work;
  }

  function legacyImageWorkPending(view) {
    return legacyImageWorkRef.current?.view === view && legacyImageWorkRef.current.pending > 0;
  }

  function finishLegacyImageWork(work) {
    work.pending -= 1;
    if (!mountedRef.current || legacyImageWorkRef.current !== work || work.view !== pickerViewRef.current) return;
    setIsPreparingLegacyImage(work.pending > 0);
  }

  function rejectLegacyImageMutation(scope) {
    if (!isLegacyImageScopeCurrent(scope)) return true;
    if (typeof scope.selectionCurrent === 'function' && !scope.selectionCurrent(scope.selectionToken)) {
      setUploadError('The previous attachment was not added because file selections changed. Attach it again if needed.');
      return true;
    }
    const live = imageViewRef.current;
    if (live.disabled) {
      setUploadError('Image attachment was canceled because input is disabled. Attach it again when input is available.');
      return true;
    }
    if (!live.attachmentsEnabled) {
      setUploadError(live.attachmentsDisabledMessage);
      return true;
    }
    if (typeof live.onComposerAttachmentAdd !== 'function') {
      setUploadError('Attachments are not available in this conversation.');
      return true;
    }
    return false;
  }

  async function attachImageFile(file, fallbackName = 'image.png', scope = captureLegacyImageScope()) {
    if (!file) return false;
    if (rejectLegacyImageMutation(scope)) {
      if (allowAnyFile && isLegacyImageScopeCurrent(scope)) requireTransferReview(scope.view, scope.transferId);
      return false;
    }

    setUploadError('');
    setIsPastingImage(true);
    const work = beginLegacyImageWork(scope);
    try {
      const path = allowAnyFile && !SCREENSHOT_MIME_TYPES.has(file.type?.toLowerCase()) ? await uploadAttachment(file) : await uploadScreenshot(file);
      if (rejectLegacyImageMutation(scope)) {
        if (allowAnyFile && isLegacyImageScopeCurrent(scope)) requireTransferReview(scope.view, scope.transferId);
        return false;
      }
      if (scope.transferId && transferReviewStore.status(scope.transferId) !== 'present') {
        setUploadError('File selection review changed while uploading. Check the current files before continuing.');
        requireTransferReview(scope.view, scope.transferId);
        return false;
      }
      if (scope.verifyClaim && (!await scope.verifyClaim() || !isLegacyImageScopeCurrent(scope) || transferReviewStore.status(scope.transferId) !== 'present')) {
        if (isLegacyImageScopeCurrent(scope)) {
          setUploadError('The saved paste upload changed in another tab. Review it before continuing.');
          requireTransferReview(scope.view, scope.transferId);
        }
        return false;
      }
      if (!path) {
        setUploadError('The upload did not return a file path. Try attaching the file again.');
        if (allowAnyFile) requireTransferReview(scope.view, scope.transferId);
        return false;
      }
      const added = imageViewRef.current.onComposerAttachmentAdd?.({
        name: file.name || fallbackName,
        path
      });
      if (added === false) {
        setUploadError('The file selection could not be saved. Check the current files before continuing.');
        if (allowAnyFile) requireTransferReview(scope.view, scope.transferId);
        return false;
      }
      return true;
    } catch (error) {
      if (!isLegacyImageScopeCurrent(scope)) return;
      const message = error instanceof Error && error.message
        ? error.message
        : 'Image upload failed';
      setUploadError(message);
      if (allowAnyFile) requireTransferReview(scope.view, scope.transferId);
      console.error('Failed to attach image from composer:', error);
      return false;
    } finally {
      if (mountedRef.current && legacyImageWorkRef.current === work && work.view === pickerViewRef.current) setIsPastingImage(false);
      finishLegacyImageWork(work);
    }
  }

  async function attachLegacyBatch(files, scope, afterSave) {
    if (!files.length) return false;
    if (rejectLegacyImageMutation(scope)) {
      if (isLegacyImageScopeCurrent(scope)) requireTransferReview(scope.view, scope.transferId);
      if (scope.transferId) finishTransfer(scope.view, scope.transferId, false);
      return false;
    }
    if (files.length + imageViewRef.current.composerAttachments.length > 100) {
      setUploadError('You can attach up to 100 files. Remove files or choose a smaller batch.');
      requireTransferReview(scope.view, scope.transferId);
      if (scope.transferId) finishTransfer(scope.view, scope.transferId, false);
      return false;
    }
    const transferId = scope.transferId || beginTransfer(scope.view);
    if (!transferId) return false;
    scope.transferId = transferId;
    const work = beginLegacyImageWork(scope);
    let attached = 0;
    let success = true;
    try {
      for (const file of files) {
        if (rejectLegacyImageMutation(scope)) { if (isLegacyImageScopeCurrent(scope)) requireTransferReview(scope.view, transferId); success = false; break; }
        if (transferReviewStore.status(transferId) !== 'present') {
          setUploadError('File selection review changed while uploading. Check the current files before continuing.');
          requireTransferReview(scope.view, transferId);
          success = false;
          break;
        }
        if (!await attachImageFile(file, 'attachment', scope)) {
          if (isLegacyImageScopeCurrent(scope)) {
            requireTransferReview(scope.view, transferId);
            setUploadError(previous => {
              const detail = previous?.trim() || 'An attachment could not be added';
              return `${detail}${/[.!?]$/.test(detail) ? '' : '.'} The server may have saved this file; retrying can create an extra copy.${attached ? ` ${attached} ${attached === 1 ? 'file was' : 'files were'} already attached; check them before retrying.` : ''}`;
            });
          }
          success = false;
          break;
        }
        attached += 1;
      }
      if (success && typeof imageViewRef.current.waitForAttachmentPersistence === 'function') {
        let saved = false;
        try { saved = await imageViewRef.current.waitForAttachmentPersistence(); } catch { /* Report the failed confirmation below. */ }
        if (!saved) {
          if (isLegacyImageScopeCurrent(scope)) {
            setUploadError('The file selections could not be saved. Check the current files before continuing.');
            requireTransferReview(scope.view, transferId);
          }
          success = false;
        }
      }
      if (success && afterSave && isLegacyImageScopeCurrent(scope)) {
        let committed = false;
        try { committed = await afterSave(); } catch { /* Keep the transfer marked for review. */ }
        if (!committed) {
          setUploadError('The pasted text was attached, but the draft changed or could not be saved. Check for duplicated text before continuing.');
          requireTransferReview(scope.view, transferId);
          success = false;
        }
      }
    } finally { finishLegacyImageWork(work); finishTransfer(scope.view, transferId, success); }
    return success;
  }

  async function saveOversizedPaste({ file, scope, before, saved, full, prefix, suffix }) {
    const keepInDraft = () => {
      if (!isLegacyImageScopeCurrent(scope) || saved) return;
      const current = composerDraftStore.getSnapshot();
      if (current.text === before.text && current.revision === before.revision) onComposerChange?.(full);
      else onComposerChange?.(`${current.text}${current.text ? '\n\n' : ''}${full.slice(prefix.length, full.length - suffix.length)}`);
    };
    let storage;
    try { storage = pasteRecovery(scope.view); } catch { storage = null; }
    if (!storage || typeof composerDraftStore?.finalizeLargePaste !== 'function') {
      keepInDraft();
      setUploadError('The pasted text could not be saved on this device. Keep this tab open and reduce the text or restore device storage.');
      requireTransferReview(scope.view);
      storage?.close();
      return;
    }
    const id = beginTransfer(scope.view, 'large-paste');
    if (!id) { keepInDraft(); storage.close(); return; }
    scope.transferId = id;
    const work = beginLegacyImageWork(scope);
    let delegated = false, claimed = false, sourceSaved = false, claimId;
    try {
      claimId = createUuid();
      await storage.save({ id, blob: file, original: before.text, prefix, suffix, revision: before.revision });
      sourceSaved = true;
      transferReviewStore.touch(id);
      if (!isLegacyImageScopeCurrent(scope)) return;
      await storage.claim(id, claimId);
      claimed = true;
      transferReviewStore.touch(id);
      scope.verifyClaim = async () => {
        const record = await storage.read();
        return record?.id === id && record.status === 'claimed' && record.claimId === claimId;
      };
      if (!isLegacyImageScopeCurrent(scope)) return;
      delegated = true;
      const completed = await attachLegacyBatch([file], scope, async () => {
        if (!await scope.verifyClaim() || !isLegacyImageScopeCurrent(scope) || transferReviewStore.status(id) !== 'present') return false;
        const finalized = saved
          ? composerDraftStore.finalizeLargePaste({ baseText: before.text, baseRevision: before.revision, localText: full, localRevision: saved.revision, remaining: prefix + suffix })
          : composerDraftStore.finalizeSavedPaste({ baseText: before.text, baseRevision: before.revision, remaining: prefix + suffix });
        if (!finalized) return false;
        if (!await storage.finish(id, claimId)) return false;
        setPasteNotice({ view: scope.view, name: file.name });
        return true;
      });
      if (!completed && isLegacyImageScopeCurrent(scope)) {
        await storage.markUncertain(id, claimId);
        transferReviewStore.touch(id);
      }
    } catch (error) {
      if (isLegacyImageScopeCurrent(scope)) {
        if (!sourceSaved) keepInDraft();
        if (claimed) { try { await storage.markUncertain(id, claimId); transferReviewStore.touch(id); } catch { /* Keep the saved claim for review. */ } }
        const detail = typeof error?.message === 'string' ? error.message.slice(0, 250) : 'The large paste could not be safely saved or uploaded.';
        setUploadError(`${detail} Keep this tab open and review the pasted text.`);
        requireTransferReview(scope.view, id);
      }
    } finally {
      finishLegacyImageWork(work);
      if (!delegated) finishTransfer(scope.view, id, false);
      storage.close();
    }
  }

  async function attachRecoveredPaste(storage, record, view) {
    const scope = captureLegacyImageScope(), initial = composerDraftStore?.getSnapshot();
    if (scope.view !== view || !initial || initial.error || rejectLegacyImageMutation(scope) || legacyImageWorkPending(view)) throw new Error('Save the current draft and wait for other uploads before retrying.');
    const text = await record.blob.text();
    if (!isLegacyImageScopeCurrent(scope) || composerDraftStore.getSnapshot().revision !== initial.revision) throw new Error('The draft changed. Review the saved paste again.');
    if (initial.text.includes(text)) throw new Error('Remove the recovered text from the draft before attaching it, so it is not sent twice.');
    const names = new Set(imageViewRef.current.composerAttachments.map(item => item.name?.toLowerCase()));
    let name = 'pasted-text.txt', sequence = 2;
    while (names.has(name)) name = `pasted-text-${sequence++}.txt`;
    const file = new File([record.blob], name, { type: record.blob.type });
    const claimId = createUuid();
    await storage.claim(record.id, claimId, { reviewUncertain: record.status === 'uncertain' });
    let complete = false, started = false;
    try {
      if (!isLegacyImageScopeCurrent(scope)) return;
      scope.transferId = record.id;
      scope.verifyClaim = async () => {
        const current = await storage.read();
        return current?.id === record.id && current.status === 'claimed' && current.claimId === claimId;
      };
      activeTransfersRef.current.set(record.id, view); setActiveTransferRevision(value => value + 1);
      largeTransfersRef.current.add(record.id);
      if (transferReviewRef.current === view && transferReviewMarkerRef.current?.id === record.id) {
        transferReviewRef.current = null; transferReviewMarkerRef.current = null; setTransferReviewView(null);
      }
      transferReviewStore.touch(record.id);
      started = true;
      complete = await attachLegacyBatch([file], scope, async () => {
        if (!await scope.verifyClaim() || !isLegacyImageScopeCurrent(scope) || transferReviewStore.status(record.id) !== 'present') return false;
        const current = composerDraftStore.getSnapshot();
        if (current.error || current.revision !== initial.revision || current.text !== initial.text) return false;
        if (initial.text === record.original && initial.revision === record.revision) {
          onComposerChange?.(record.prefix + record.suffix);
          const updated = composerDraftStore.getSnapshot();
          if (updated.error || updated.text !== record.prefix + record.suffix) return false;
        }
        if (!await storage.finish(record.id, claimId)) return false;
        setPasteNotice({ view, name });
        return true;
      });
    } finally {
      if (!complete && isLegacyImageScopeCurrent(scope)) {
        try { await storage.markUncertain(record.id, claimId); transferReviewStore.touch(record.id); } catch { /* Retain the claim for review. */ }
        if (!started) finishTransfer(view, record.id, false);
      }
    }
  }

  async function reviewLargePaste(action) {
    const review = largePasteReview, view = pickerViewRef.current;
    if (!review || review.view !== view || largePasteAction.current) return;
    largePasteAction.current = true;
    let storage;
    try {
      storage = pasteRecovery(view);
      if (!storage) throw new Error('Saved paste storage is unavailable.');
      const record = await storage.read();
      if (view !== pickerViewRef.current) return;
      let markerKind = transferReviewStore.kind(review.marker);
      if (action === 'continue-without-recovery') {
        if (record) throw new Error('A saved paste is available. Restore or discard it before continuing.');
        if (markerKind !== 'large-paste') throw new Error('The review warning changed. Check it again.');
        if (!transferReviewStore.clear([review.marker])) throw new Error('The review warning could not be cleared.');
      } else {
        if (!record || record.id !== review.marker) throw new Error('The saved paste is unavailable or changed.');
        if (action === 'restore') {
          const text = await record.blob.text();
          if (view !== pickerViewRef.current || !isAuthScopeCurrent(JSON.parse(authScopeKey))) return;
          const current = composerDraftStore?.getSnapshot();
          if (!current || typeof onComposerChange !== 'function') throw new Error('The current draft is unavailable.');
          if (!current.text.includes(text)) {
            const next = current.text === record.original && current.revision === record.revision
              ? record.prefix + text + record.suffix : `${current.text}${current.text ? '\n\n' : ''}${text}`;
            onComposerChange(next);
          }
          setUploadError('The recovered text is in this tab and remains saved for review. It may be too large for the normal draft store.');
          return;
        }
        if (action === 'mark-uncertain') {
          if (!await storage.markUncertain(record.id, record.claimId)) throw new Error('The upload state changed. Review it again.');
          transferReviewStore.touch(review.marker);
          return;
        }
        if (action === 'attach') {
          if (markerKind === 'missing') {
            transferReviewStore.mark(record.id, 'large-paste');
            markerKind = transferReviewStore.kind(record.id);
          }
          if (markerKind !== 'large-paste') throw new Error('The review warning could not be saved. Check device storage before retrying.');
          await attachRecoveredPaste(storage, record, view); return;
        }
        if (action === 'discard') {
          if (composerDraftStore?.getSnapshot().error) throw new Error('The current draft is not saved. Shorten it or restore device storage before discarding the saved paste.');
          if (!await storage.clear(record.id)) throw new Error('The saved paste changed. Review it again.');
          if (markerKind === 'large-paste' && !transferReviewStore.clear([review.marker])) throw new Error('The review warning could not be cleared.');
        }
      }
      if (transferReviewRef.current === view && transferReviewMarkerRef.current?.id === review.marker) {
        transferReviewRef.current = null; transferReviewMarkerRef.current = null; setTransferReviewView(null);
      }
      setUploadError(''); setLargePasteReview(null);
    } catch (error) {
      if (mountedRef.current && view === pickerViewRef.current) setUploadError(error?.message || 'The saved paste could not be reviewed.');
    } finally { storage?.close(); largePasteAction.current = false; }
  }

  function hasFileDrag(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    return types.includes('Files') || types.includes('public.file-url');
  }

  function rejectFolderTransfer(dataTransfer) {
    let message = '';
    try {
      if (containsDroppedFolder(dataTransfer)) message = 'Folders cannot be attached in this browser. No files were attached; choose individual files instead.';
    } catch { message = 'The dropped items could not be inspected. No files were attached; choose individual files instead.'; }
    if (!message) return false;
    if (userImages && (!imageScopeMatches || !sameImageView(userImages))) return true;
    requireTransferReview(pickerViewRef.current);
    if (userImages) setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message });
    else setUploadError(message);
    return true;
  }

  function handleGitBranchChange(event) {
    const nextBranch = typeof event === 'string' ? event : event?.target?.value;
    if (!nextBranch) return;
    onSelectGitBranch?.(nextBranch);
  }

  function handleComposerKeyDown(event) {
    if (compositionRef.current || event.isComposing || event.nativeEvent?.isComposing
      || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return;
    const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
    if (event.key.toLowerCase() === 'v' && event.shiftKey && !event.altKey
      && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) pasteAsTextUntil.current = Date.now() + 1000;
    const handled = autocorrectKeyDown(event);
    if (handled) return;
    if (isMobile && event.key === 'Enter' && !event.metaKey && !event.ctrlKey) return;

    if (slashSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const suggestion = slashSuggestions[selectedSlashIndex];
        if (suggestion.insert) insertSuggestion(suggestion);
        else handleComposerSubmit(event, joinContext(contextChips, suggestion.cmd));
        return;
      }

      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        insertSuggestion(slashSuggestions[selectedSlashIndex]);
        return;
      }
    }

    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !userImages) {
      const browsing = historyIndexRef.current !== -1 && event.currentTarget.value === historyRecalledRef.current;
      if (event.currentTarget.value === '' || browsing) {
        const step = stepPromptHistory(readPromptHistory(sessionId), browsing ? historyIndexRef.current : -1, event.key === 'ArrowUp' ? 'up' : 'down');
        if (step) {
          event.preventDefault();
          historyIndexRef.current = step.index;
          historyRecalledRef.current = step.text;
          setDraftText(step.text);
          return;
        }
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleComposerSubmit(event, userImages ? composerValue : joinContext(contextChips, event.currentTarget?.value ?? draftText));
    }
  }

  async function handleComposerPaste(event) {
    const scope = captureLegacyImageScope();
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    const pasteAsText = pasteNextAsTextRef.current === scope.view || Date.now() <= pasteAsTextUntil.current;
    pasteAsTextUntil.current = 0;
    if (pasteNextAsTextRef.current === scope.view) { pasteNextAsTextRef.current = null; setPasteNextAsTextView(null); }
    if (hasTransferReview()) {
      if (suppliedFiles(clipboardData).length) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (rejectFolderTransfer(clipboardData)) { event.preventDefault(); event.stopPropagation(); return; }
    const files = suppliedFiles(clipboardData);
    const pastedText = clipboardData.getData?.('text/plain');
    if (!files.length && !pasteAsText && !userImages && allowAnyFile && attachmentsEnabled && !composerDisabled
      && !legacyImageWorkPending(scope.view) && composerDraftStore && typeof pastedText === 'string'
      && (pastedText.length >= LARGE_PASTE_BYTES || new TextEncoder().encode(pastedText).length >= LARGE_PASTE_BYTES)
      && !/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(pastedText)) {
      const before = composerDraftStore.getSnapshot();
      if (before.text === composerValue && !before.error) {
        const baseDurable = typeof composerDraftStore.ensureSavedForPaste === 'function'
          && composerDraftStore.ensureSavedForPaste(before.text, before.revision);
        const names = new Set(composerAttachments.map(item => item.name?.toLowerCase()));
        let name = 'pasted-text.txt', sequence = 2;
        while (names.has(name)) name = `pasted-text-${sequence++}.txt`;
        const file = new File([pastedText], name, { type: 'text/plain;charset=utf-8' });
        if (file.size <= 25 * 1024 * 1024) {
          const start = rawTextOffset(draftText, event.currentTarget.selectionStart ?? draftText.length);
          const end = rawTextOffset(draftText, event.currentTarget.selectionEnd ?? draftText.length);
          const prefix = joinContext(contextChips, draftText.slice(0, start)), suffix = draftText.slice(end);
          const full = prefix + pastedText + suffix;
          const remaining = prefix + suffix;
          if (baseDurable && scope.auth.userId && new TextEncoder().encode(full).length >= 900_000) {
            event.preventDefault(); event.stopPropagation();
            await saveOversizedPaste({ file, scope, before, saved: null, full, prefix, suffix });
            return;
          }
          onComposerChange?.(full);
          const saved = composerDraftStore.getSnapshot();
          if (saved.text === full) {
            event.preventDefault(); event.stopPropagation();
            if (saved.error) {
              if (baseDurable && scope.auth.userId) {
                await saveOversizedPaste({ file, scope, before, saved, full, prefix, suffix });
                return;
              }
              setUploadError('The pasted text could not be saved on this device. Keep this tab open and reduce the text or restore device storage.');
              requireTransferReview(scope.view);
              return;
            }
            const revision = saved.revision;
            await attachLegacyBatch([file], scope, () => {
              const current = composerDraftStore.getSnapshot();
              if (current.error || current.revision !== revision || current.text !== full) return false;
              onComposerChange?.(remaining);
              const updated = composerDraftStore.getSnapshot();
              if (updated.error || updated.text !== remaining) return false;
              setPasteNotice({ view: scope.view, name });
              return true;
            });
            return;
          }
        }
      }
    }
    if (userImages) {
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!sameImageView(userImages)) return;
      if (!canAddUserImages) { await addOwnedFiles(files, 'paste'); return; }
      const pasted = clipboardData.getData?.('text/plain');
      if (pasted && typeof pasted === 'string') {
        const start = rawTextOffset(draftText, event.currentTarget.selectionStart ?? draftText.length);
        const end = rawTextOffset(draftText, event.currentTarget.selectionEnd ?? draftText.length);
        setDraftText(draftText.slice(0, start) + pasted + draftText.slice(end));
      }
      await addOwnedFiles(files, 'paste');
      return;
    }

    if (allowAnyFile && legacyImageWorkPending(scope.view)) {
      if (files.length) {
        event.preventDefault(); event.stopPropagation();
        setUploadError('Wait for the current upload to finish before attaching more files.');
        requireTransferReview(scope.view);
      }
      return;
    }

    if (allowAnyFile && files.length) {
      event.preventDefault(); event.stopPropagation();
      if (rejectLegacyImageMutation(scope)) { if (isLegacyImageScopeCurrent(scope)) requireTransferReview(scope.view); return; }
      const pasted = clipboardData.getData?.('text/plain');
      if (pasted && typeof pasted === 'string') {
        const start = rawTextOffset(draftText, event.currentTarget.selectionStart ?? draftText.length);
        const end = rawTextOffset(draftText, event.currentTarget.selectionEnd ?? draftText.length);
        setDraftText(draftText.slice(0, start) + pasted + draftText.slice(end));
      }
      await attachLegacyBatch(files, scope);
      return;
    }

    const work = beginLegacyImageWork(scope);
    try {
      const imageFile = await getImageFileFromDataTransfer(clipboardData);
      if (!imageFile || !isLegacyImageScopeCurrent(scope)) return;
      event.preventDefault();
      event.stopPropagation();
      if (allowAnyFile) await attachLegacyBatch([imageFile], scope);
      else await attachImageFile(imageFile, 'image.png', scope);
    } catch (error) {
      if (isLegacyImageScopeCurrent(scope)) setUploadError(error.message || 'Unable to inspect image. Try attaching it again.');
      console.error('Failed to inspect pasted image data for composer:', error);
    } finally {
      finishLegacyImageWork(work);
    }
  }

  async function handleImageSelect(event) {
    const node = event.currentTarget, lease = pickerLeaseRef.current;
    const files = Array.from(node.files || []); node.value = '';
    if (!lease || lease.node !== node || lease.view !== pickerViewRef.current) return;
    pickerLeaseRef.current = null;
    if (hasTransferReview()) return;
    if (lease.purpose === 'restore_original') {
      if (lease.binding !== pickerBindingRef.current || !sameOriginalRow(lease.request) || files.length !== 1) return;
      await imageAction('selectOriginalImage', files[0], lease.request); return;
    }
    if (userImages) {
      if (files.length) await addOwnedFiles(files, 'picker');
      return;
    }
    if (allowAnyFile && legacyImageWorkPending(lease.view)) {
      setUploadError('Wait for the current upload to finish before attaching more files.');
      requireTransferReview(lease.view);
      return;
    }
    if (allowAnyFile) await attachLegacyBatch(files, lease.legacyScope || captureLegacyImageScope());
    else if (files[0]) await attachImageFile(files[0], 'image.png', lease.legacyScope || captureLegacyImageScope());
  }

  function handleComposerDragOver(event) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (hasTransferReview()) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
    if (userImages ? !canAddUserImages : !attachmentsEnabled || (allowAnyFile && legacyImageWorkPending(pickerViewRef.current))) {
      setIsImageDragOver(false);
      if (!userImages) setUploadError(attachmentsEnabled ? 'Wait for the current upload to finish before attaching more files.' : attachmentsDisabledMessage);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    setUploadError('');
    setIsImageDragOver(true);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleComposerDragLeave(event) {
    if (!isImageDragOver) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsImageDragOver(false);
  }

  async function handleComposerDrop(event) {
    const scope = captureLegacyImageScope();
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsImageDragOver(false);
    if (hasTransferReview()) return;
    if (!userImages && allowAnyFile && legacyImageWorkPending(scope.view)) {
      setUploadError('Wait for the current upload to finish before attaching more files.');
      requireTransferReview(scope.view);
      return;
    }
    if (rejectFolderTransfer(event.dataTransfer)) return;
    if (userImages) { await addOwnedFiles(suppliedFiles(event.dataTransfer), 'drop'); return; }

    const droppedFiles = suppliedFiles(event.dataTransfer);
    if (allowAnyFile && droppedFiles.length) { await attachLegacyBatch(droppedFiles, scope); return; }

    const work = beginLegacyImageWork(scope);
    try {
      const imageFile = await getImageFileFromDataTransfer(event.dataTransfer);
      if (!isLegacyImageScopeCurrent(scope)) return;
      if (!imageFile) {
        setUploadError('Drop an image file to attach it.');
        return;
      }
      if (allowAnyFile) await attachLegacyBatch([imageFile], scope);
      else await attachImageFile(imageFile, 'image.png', scope);
    } catch (error) {
      if (!isLegacyImageScopeCurrent(scope)) return;
      const message = error instanceof Error && error.message
        ? error.message
        : 'Image upload failed';
      setUploadError(message);
      console.error('Failed to drop image into composer:', error);
    } finally {
      finishLegacyImageWork(work);
    }
  }

  const canSubmitComposer = !composerDisabled
    && !composerSubmitDisabled
    && !requiresTransferReview
    && !ownedImageWorkPending
    && !voiceBusy
    && !isInterrupting && !requiresCleanup
    && (userImages || !isPreparingLegacyImage)
    && (userImages ? canSendUserImages : attachmentsEnabled || composerAttachments.length === 0)
    && (Boolean(composerValue.trim()) || (userImages ? imageItems.length > 0 : composerAttachments.length > 0))
    && typeof onComposerSubmit === 'function';
  const showStop = isStreaming || isInterrupting || requiresCleanup;
  const stopLabel = isInterrupting ? 'Stopping response' : requiresCleanup ? 'Retry cancellation' : 'Stop response';

  const canScrollCompact = collapseOnScroll && compactConversation && !compactInputOptions && !isMobile
    && !composerDisabled && !draftText.includes('\n') && !draftText.includes('\r')
    && !voiceBusy && !isAiMenuOpen && !composerOptionsOpen && !contextOpen && !isProviderAuthOpen
    && !isImageDragOver && !isPastingImage && !isPreparingLegacyImage;
  useEffect(() => { setScrollCompact(false); }, [sessionId]);
  useEffect(() => {
    if (!canScrollCompact) setScrollCompact(false);
  }, [canScrollCompact]);
  useEffect(() => {
    if (!canScrollCompact) return undefined;
    const shell = composerShellRef.current;
    const stack = shell?.closest('.desktop-terminal-stack');
    if (!shell || !stack) return undefined;
    let accumulated = 0;
    let lastTime = 0;
    let lastDirection = 0;
    const hasExtraContent = () => Boolean(shell.querySelector('[aria-expanded="true"], details[open]'))
      || [...shell.children].some(child => !child.matches('textarea, input.status-composer-image-input, .status-bar-right'));
    const nestedCanScroll = (target, thread, direction) => {
      for (let node = target; node && node !== thread; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
          && (direction < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight)) return true;
      }
      return false;
    };
    const onWheel = event => {
      if (event.ctrlKey || !(event.target instanceof Element) || !event.deltaY) return;
      const thread = event.target.closest('.desktop-thread');
      if (!thread || !stack.contains(thread) || shell.contains(document.activeElement)
        || shell.getBoundingClientRect().width < 720 || hasExtraContent()) return;
      if (nestedCanScroll(event.target, thread, event.deltaY)) return;
      const canScroll = event.deltaY < 0 ? thread.scrollTop > 0 : thread.scrollTop < thread.scrollHeight - thread.clientHeight - 1;
      if (!canScroll) return;
      const direction = Math.sign(event.deltaY);
      const now = performance.now();
      if (direction !== lastDirection || now - lastTime > 120) accumulated = 0;
      accumulated += Math.abs(event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? thread.clientHeight : 1);
      lastTime = now;
      lastDirection = direction;
      if (accumulated >= 24) setScrollCompact(true);
    };
    const onScroll = event => {
      const thread = event.target;
      if (thread instanceof Element && thread.classList.contains('desktop-thread')
        && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 2) setScrollCompact(false);
    };
    const onKeyDown = event => {
      if (event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof Element)
        || event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      const thread = event.target.closest('.desktop-thread');
      if (!thread || !stack.contains(thread) || shell.contains(document.activeElement)
        || shell.getBoundingClientRect().width < 720 || hasExtraContent()) return;
      const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key);
      const downward = ['ArrowDown', 'PageDown', 'End'].includes(event.key);
      if ((!upward && !downward) || nestedCanScroll(event.target, thread, upward ? -1 : 1)) return;
      if ((upward && thread.scrollTop > 0)
        || (downward && thread.scrollTop < thread.scrollHeight - thread.clientHeight - 1)) setScrollCompact(true);
    };
    stack.addEventListener('wheel', onWheel, { passive: true });
    stack.addEventListener('scroll', onScroll, true);
    stack.addEventListener('keydown', onKeyDown);
    return () => { stack.removeEventListener('wheel', onWheel); stack.removeEventListener('scroll', onScroll, true); stack.removeEventListener('keydown', onKeyDown); };
  }, [canScrollCompact]);
  useEffect(() => {
    if (!scrollCompact) return undefined;
    const shell = composerShellRef.current;
    const input = composerInputRef.current;
    if (!shell || !input) return undefined;
    const check = () => {
      if (shell.getBoundingClientRect().width < 720 || shell.scrollWidth > shell.clientWidth + 1
        || input.scrollHeight > input.clientHeight + 2
        || shell.querySelector('[aria-expanded="true"], details[open]')
        || [...shell.children].some(child => !child.matches('textarea, input.status-composer-image-input, .status-bar-right'))) setScrollCompact(false);
    };
    const frame = requestAnimationFrame(check);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    resize?.observe(shell);
    resize?.observe(input);
    const changes = new MutationObserver(check);
    changes.observe(shell, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'open'] });
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); changes.disconnect(); };
  }, [scrollCompact]);

  const sessionContext = resolvedShowComposerFooter && <div className="composer-session-context" onKeyDown={event => {
    if (event.key !== 'Escape' || !contextOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setContextOpen(false);
    contextTriggerRef.current?.focus();
  }}>
    <button type="button" className="status-bar-btn session-context-trigger" ref={contextTriggerRef}
      aria-label="Session context" title="Session context" aria-haspopup="dialog"
      aria-expanded={contextOpen} aria-controls={contextOpen ? contextId : undefined}
      onClick={() => setContextOpen(open => !open)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg>
      {compactInputOptions && <span>Session context</span>}
    </button>
    {contextOpen && <div className="session-context-popover" ref={contextPanelRef} id={contextId}
      role="dialog" aria-label="Session context" tabIndex={-1}>
      <strong>Session context</strong>
      {cwd && <div className="session-context-detail"><span>Directory</span><span>{cwd}</span></div>}
      {runtimeInfo?.label && <div className="session-context-detail"><span>Runtime</span><span>{runtimeInfo.label}</span></div>}
      {(gitBranches.length > 0 || currentGitBranch || gitBranch) && <div className="session-context-detail">
        <span>Branch</span>
        {gitBranches.length > 0 && onSelectGitBranch ? <select aria-label="Select git branch"
          value={currentGitBranch || gitBranch || ''} disabled={isLoadingGitBranches || isSwitchingGitBranch}
          onChange={handleGitBranchChange}>
          {!gitBranches.includes(currentGitBranch || gitBranch || '') && <option value={currentGitBranch || gitBranch || ''}>{currentGitBranch || gitBranch || 'Select a branch'}</option>}
          {gitBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
        </select> : <span>{currentGitBranch || gitBranch}</span>}
      </div>}
    </div>}
  </div>;

  return (
    <div className={`desktop-status-bar desktop-status-bar-shell workspace-composer${isActive ? ' pane-active' : ''}${userImages ? ' user-image-composer' : ''}${compactConversation ? ' unified-conversation-composer' : ''}`}>
      <ProviderAuthModal isOpen={isProviderAuthOpen} onClose={() => setIsProviderAuthOpen(false)} sessionId={sessionId} />      {resolvedShowTopRow && (
        <div className="status-bar-meta-row">
          <div className="status-bar-left" />

          <div className="status-bar-top-actions">
            {showTerminalViewModeToggle && (
              <div
                className="status-view-mode-toggle"
                role="group"
                aria-label="Terminal view mode"
              >
                <button
                  type="button"
                  className={`status-view-mode-option ${isCodexViewMode ? 'active' : ''}`}
                  onClick={() => handleTerminalViewModeSelect('codex')}
                  disabled={!onToggleTerminalViewMode}
                  aria-pressed={isCodexViewMode ? 'true' : 'false'}
                  aria-label="Show Codex UI"
                  title="Show the Codex-style transcript"
                >
                  Codex UI
                </button>
                <button
                  type="button"
                  className={`status-view-mode-option ${isRawTerminalViewMode ? 'active' : ''}`}
                  onClick={() => handleTerminalViewModeSelect('terminal')}
                  disabled={!onToggleTerminalViewMode}
                  aria-pressed={isRawTerminalViewMode ? 'true' : 'false'}
                  aria-label="Show Raw Terminal"
                  title="Show the interactive raw terminal"
                >
                  Raw Terminal
                </button>
              </div>
            )}
            {showTerminalToggle && (
              <button
                type="button"
                className={`status-terminal-toggle ${isTerminalPanelOpen ? 'active' : ''}`}
                onClick={onToggleTerminalPanel}
                disabled={!onToggleTerminalPanel}
                aria-label={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
                title={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
              >
                {isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
              </button>
            )}
          </div>
        </div>
      )}

      <form
        ref={composerShellRef}
        className={`status-composer-shell${scrollCompact ? ' scroll-compact' : ''}${composerDisabled ? ' disabled' : ''}${isImageDragOver ? ' image-drag-over' : ''}`}
        onSubmit={handleComposerSubmit}
        onFocusCapture={event => { if (event.target === composerInputRef.current) setScrollCompact(false); }}
        onPointerDownCapture={event => {
          if (event.target === event.currentTarget || event.target === composerInputRef.current) setScrollCompact(false);
        }}
        onClick={event => {
          if (event.target === event.currentTarget && !composerDisabled) composerInputRef.current?.focus();
          else if (event.target instanceof Element && event.target.closest('button, summary, select, a')) setScrollCompact(false);
        }}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        {composerAttachments.length > 0 && (
          <div className="status-composer-attachments" aria-label="Composer attachments">
            {composerAttachments.map((attachment, index) => (
              <div key={`${attachment.path}-${index}`} className="status-composer-attachment-chip">
                <span className="status-composer-attachment-dot" aria-hidden="true" />
                <span className="status-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  className="status-composer-attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={composerDisabled}
                  onClick={() => onComposerAttachmentRemove?.(attachment.path)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {userImages && (imageScopeMatches ? <UserImageAttachments userImages={userImages} disabled={composerDisabled} onAction={imageAction} />
          : <p role="status">Selected image draft is loading or unavailable.</p>)}
        {currentImageError && currentImageError !== String(userImages?.error || '').slice(0, 400)
          && <p className="user-image-draft-error" role="alert">{currentImageError}</p>}
        {!userImages && !attachmentsEnabled && showImageButton && <div className="status-composer-upload-error">Attachments are not supported in V4 conversations yet.</div>}
        {!userImages && uploadError && (
          <div className="status-composer-upload-error" role="alert">
            {uploadError}
          </div>
        )}
        {pasteNotice?.view === pickerView && composerAttachments.some(item => item.name === pasteNotice.name) && <p role="status">Large paste attached as {pasteNotice.name}.{!isMobile && !compactInputOptions && <> Use {/Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ? '⌘⇧V' : 'Ctrl+Shift+V'} to paste as text.</>}</p>}
        {pasteNextAsTextView === pickerView && <div className="status-composer-voice-status"><span role="status">Next paste will stay as text.</span><button type="button" onClick={() => { pasteNextAsTextRef.current = null; setPasteNextAsTextView(null); }}>Cancel</button></div>}
        {!localReview && genericTransferReviews.length > 0 && <div className="status-composer-upload-error" role="alert">A previous file selection did not finish or may still be running in another tab. Check the files in this draft and other tabs before continuing.{genericTransferReviews.length > 1 ? ` ${genericTransferReviews.length} selections need review.` : ''}</div>}
        {localReview && otherTransferReviews.length > 0 && <div className="status-composer-upload-error" role="status">{otherTransferReviews.length} other {otherTransferReviews.length === 1 ? 'selection needs' : 'selections need'} review, possibly in other tabs.</div>}
        {(transferReviewStorageError || transferReviewSnapshot === 'unavailable') && <div className="status-composer-upload-error" role="status">Could not save or read the review warning. Keep this tab open until you have checked the files and restored device storage.</div>}
        {largePasteReview?.view === pickerView && largePasteReview.state === 'loading' && <p role="status">Checking saved paste recovery…</p>}
        {largePasteReview?.view === pickerView && largePasteReview.state === 'ready' && <div className="status-composer-upload-error status-large-paste-review" role="alert">
          <p>A saved large paste needs review. Its text is stored on this device.</p>
          {largePasteReview.record.status === 'claimed' && <p>The previous upload may still be running in another tab. Check other tabs before continuing.</p>}
          {largePasteReview.record.status === 'uncertain' && <p>The previous upload may have saved a copy on the server. Retrying can create another copy.</p>}
          {(userImages || !allowAnyFile || !attachmentsEnabled) && <p>Files cannot be attached in this conversation. You can restore the text or discard the saved copy.</p>}
          <div className="status-large-paste-actions">
          <button type="button" className="status-transfer-review" onClick={() => reviewLargePaste('restore')}>Restore saved text</button>
          {largePasteReview.record.status === 'claimed'
            ? <button type="button" className="status-transfer-review" onClick={() => reviewLargePaste('mark-uncertain')}>I checked other tabs</button>
            : <><button type="button" className="status-transfer-review" disabled={Boolean(composerDraftStore?.getSnapshot().error) || Boolean(userImages) || !allowAnyFile || !attachmentsEnabled || composerDisabled} onClick={() => reviewLargePaste('attach')}>{largePasteReview.record.status === 'uncertain' ? 'Retry saved paste upload' : 'Attach saved paste'}</button>
              <button type="button" className="status-transfer-review" disabled={Boolean(composerDraftStore?.getSnapshot().error)} onClick={() => reviewLargePaste('discard')}>Discard saved paste</button></>}
          </div>
          {composerDraftStore?.getSnapshot().error && <p>The current draft is not saved. Shorten it or restore device storage before discarding the saved paste.</p>}
        </div>}
        {largePasteReview?.view === pickerView && largePasteReview.state === 'missing' && <div className="status-composer-upload-error">The saved paste is not available yet. It may still be saving in another tab. <button type="button" className="status-transfer-review" onClick={() => reviewLargePaste('continue-without-recovery')}>Continue without recovery</button></div>}
        {largePasteReview?.view === pickerView && largePasteReview.state === 'unavailable' && <p role="alert">Saved paste recovery is unavailable. Keep this tab open and restore device storage before continuing.</p>}
        {(localReview || displayedTransferReviews.length > 0) && !reviewingLargePaste && transferReviewSnapshot !== 'unavailable' && <button type="button" className="status-transfer-review" onClick={() => {
          const local = transferReviewRef.current === pickerViewRef.current;
          const marker = transferReviewMarkerRef.current?.view === pickerViewRef.current ? transferReviewMarkerRef.current.id : null;
          const reviewed = local ? (marker && displayedTransferReviews.includes(marker) ? [marker] : []) : displayedTransferReviews.slice(0, 1);
          if (transferReviewStore.getSnapshot() === 'unavailable' || !transferReviewStore.clear(reviewed)) { setTransferReviewStorageError(true); return; }
          if (local) { transferReviewRef.current = null; transferReviewMarkerRef.current = null; setTransferReviewView(null); setUploadError(''); setImageActionError(null); }
          setTransferReviewStorageError(false);
        }}>Continue with current files</button>}
        {!composerOptionsOpen && (compactConversation || compactInputOptions) && showMicButtons && currentVoiceStates.filter(([key, state]) => key !== 'direct' && state.error).map(([key, state]) => (
          <div className="status-composer-upload-error" role="alert" key={key}>{state.error}</div>
        ))}
        {voiceInterruptions[sessionId] && <div className="status-composer-upload-error" role="alert">
          Voice input was cancelled before a transcript was added.
          <button type="button" onClick={() => setVoiceInterruptions(current => ({ ...current, [sessionId]: false }))} aria-label="Dismiss voice cancellation">Dismiss</button>
        </div>}
        {activeVoice && <div className="status-composer-voice-status">
          <span role="status">{activeVoice[1].isTranscribing ? 'Transcribing voice input…' : activeVoice[1].isRecording ? 'Recording voice input…' : activeVoice[1].isRequesting ? 'Requesting microphone access…' : 'Checking voice input…'}</span>
          <button type="button" onClick={activeVoice[1].cancelRecording} aria-label="Cancel voice input">Cancel</button>
        </div>}
        {!userImages && isPastingImage && <p className="status-composer-upload-status" role="status">{allowAnyFile ? 'Uploading attachment…' : 'Uploading image…'}</p>}
        {!userImages && isPreparingLegacyImage && !isPastingImage && <p className="status-composer-upload-status" role="status">Preparing attachment…</p>}
        <ContextChips chips={contextChips} unavailable={isContextUnavailable} onRemove={index => onComposerChange?.(removeContext(composerValue, index))} />
        {slashSuggestions.length > 0 && (
          <div className="status-slash-menu" role="listbox" aria-label={activeMention != null ? (mentionThreads.length || mentionPullRequests.length ? 'Mentions' : 'File mentions') : 'Slash commands'}>
            {slashSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.key || suggestion.cmd}
                type="button"
                role="option"
                aria-selected={index === selectedSlashIndex ? 'true' : 'false'}
                className={`status-slash-option${index === selectedSlashIndex ? ' selected' : ''}`}
                onClick={() => {
                  insertSuggestion(suggestion);
                  composerInputRef.current?.focus();
                }}
              >
                <span className="status-slash-command">{suggestion.cmd}</span>
                <span className="status-slash-description">{suggestion.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={composerInputRef}
          className="status-composer-input"
          value={draftText}
          onChange={(event) => {
            const input = event.currentTarget;
            setComposerSelection({ value: input.value, start: input.selectionStart, end: input.selectionEnd });
            setDraftText(input.value);
          }}
          onKeyDown={handleComposerKeyDown}
          onBlur={() => { pasteAsTextUntil.current = 0; }}
          onCompositionStart={() => { compositionRef.current = true; }}
          onCompositionEnd={() => { compositionRef.current = false; }}
          onSelect={(event) => {
            const input = event.currentTarget;
            setComposerSelection({ value: input.value, start: input.selectionStart, end: input.selectionEnd });
            handleAutocorrectSelectionChange(event);
          }}
          onPaste={handleComposerPaste}
          placeholder={composerPlaceholder}
          aria-label="Command composer"
          rows={1}
          enterKeyHint={isMobile ? 'enter' : 'send'}
          autoComplete="off"
          autoCorrect={autocorrectEnabled ? 'on' : 'off'}
          autoCapitalize={autocorrectEnabled ? 'sentences' : 'off'}
          spellCheck={autocorrectEnabled}
          disabled={composerDisabled || (!userImages && !allowAnyFile && isPastingImage)}
        />
        <input
          key={currentRestoreOpening ? `restore-${currentRestoreOpening.id}` : 'add'}
          ref={imageInputRef}
          type="file"
          accept={userImages ? OWNED_IMAGE_INPUT_ACCEPT : allowAnyFile ? undefined : IMAGE_INPUT_ACCEPT}
          multiple={Boolean(userImages) ? !currentRestoreOpening : allowAnyFile}
          aria-label={currentRestoreOpening ? 'Choose original image file' : userImages ? 'Choose images' : undefined}
          className="status-composer-image-input"
          onChange={handleImageSelect}
          tabIndex={-1}
          aria-hidden={userImages ? undefined : true}
        />

        <div className="status-bar-right" ref={composerActionsRef}>
        {showImageButton && (
          <button
            type="button"
            className="status-bar-btn status-attach-btn"
            onClick={() => {
              if (pickerViewRef.current !== pickerView || (userImages && (!canAddUserImages || !sameImageView(userImages)))) return;
              const view = pickerViewRef.current; pickerLeaseRef.current = null;
              flushSync(() => setRestoreOpening(null));
              if (pickerViewRef.current !== view || (userImages && (!canAddUserImages || !sameImageView(userImages)))) return;
              const node = imageInputRef.current;
              if (!node?.isConnected) return;
              pickerLeaseRef.current = { view, node, purpose: 'add_images', legacyScope: userImages ? null : captureLegacyImageScope() };
              node.click();
            }}
            disabled={requiresTransferReview || (userImages ? !canAddUserImages : composerDisabled || isPastingImage || (allowAnyFile && isPreparingLegacyImage) || !attachmentsEnabled)}
            aria-label={allowAnyFile && !userImages ? 'Attach file' : 'Add image'}
            title={allowAnyFile && !userImages ? 'Attach files (up to 25 MiB each; screenshot formats up to 10 MiB)' : 'Add image'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
            </svg>
          </button>
        )}
        {showAiSelector && (
          <div className="status-ai-controls" ref={aiMenuRef} onKeyDown={handleAiMenuKeyDown}
            onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setIsAiMenuOpen(false); }}>
            <button
              type="button"
              className={`status-ai-selector ${isAiMenuOpen ? 'active' : ''}`}
              onClick={() => setIsAiMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={isAiMenuOpen ? 'true' : 'false'}
              aria-label="Choose AI coder"
              title={`Assistant: ${selectedAiOption.label}`}
            >
              {aiType ? <span
                className="status-ai-swatch"
                style={{ backgroundColor: selectedAiOption.color ?? 'var(--accent-primary)' }}
                aria-hidden="true"
              /> : <svg className="status-ai-cli-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 6 6-6 6m9 0h7" /></svg>}
              <span className="status-ai-selector-label">{selectedAiOption.label}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {isAiMenuOpen && (
              <div className="status-ai-menu" role="menu" aria-label="AI coder options">
                {aiOptions.map((option) => {
                  const isSelected = option.id === aiType || (!option.id && !aiType);
                  return (
                    <button
                      key={option.id ?? 'cli'}
                      type="button"
                      className={`status-ai-menu-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleAiTypeSelect(option.id)}
                      role="menuitemradio"
                      aria-checked={isSelected ? 'true' : 'false'}
                    >
                      <span
                        className="status-ai-swatch"
                        style={{ backgroundColor: option.color ?? 'var(--accent-primary)' }}
                        aria-hidden="true"
                      />
                      <span className="status-ai-menu-label">{option.label}</span>
                      {isSelected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="status-ai-menu-item status-ai-menu-auth"
                  onClick={() => { setIsProviderAuthOpen(true); setIsAiMenuOpen(false); }}
                  role="menuitem"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" /></svg>
                  <span className="status-ai-menu-label">Provider authentication</span>
                </button>
                <button
                  type="button"
                  className="status-ai-menu-item status-ai-menu-add"
                  onClick={handleAddCustomCommand}
                  role="menuitem"
                >
                  <span className="status-ai-menu-plus" aria-hidden="true">+</span>
                  <span className="status-ai-menu-label">Add custom command</span>
                </button>
              </div>
            )}
          </div>
        )}

        {composerPrimaryAction}
        {compactInputOptions && showMicButtons && <div className="composer-direct-voice">
          <TerminalMicButton
            key={`direct-${sessionId}`}
            sessionId={sessionId}
            available={voiceAvailable}
            inline
            disabled={composerDisabled || isPastingImage || (voiceBusy && activeVoice[0] !== 'direct')}
            onStateChange={handleDirectVoiceState}
            onTranscript={handleComposerTranscript}
          />
        </div>}
        {compactConversation || compactInputOptions || mobilePasteMenu ? <details className="composer-input-options" ref={composerOptionsRef} onToggle={event => setComposerOptionsOpen(event.currentTarget.open)} onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          setComposerOptionsOpen(false);
          event.currentTarget.querySelector('summary')?.focus();
        }}>
          <summary aria-label={compactInputOptions || mobilePasteMenu ? 'More composer actions' : 'Input options'} aria-describedby={compactInputOptions && composerContext ? `${contextId}-usage` : undefined} title={compactInputOptions || mobilePasteMenu ? 'More composer actions' : 'Dictation and spelling'}
            onClick={event => {
              event.preventDefault();
              const details = composerOptionsRef.current;
              if (!details) return;
              details.open = !details.open;
              setComposerOptionsOpen(details.open);
            }}>
            {compactInputOptions || mobilePasteMenu ? <span aria-hidden="true" className="composer-options-label">···{composerContext && <span className="composer-context-reading">{composerContext.percent}%</span>}</span> :
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="21" />
            </svg>}
          </summary>
          {compactInputOptions && composerContext && <span id={`${contextId}-usage`} hidden>Last provider-reported context: {composerContext.detail}.</span>}
          <div className="composer-input-options-menu">        {compactInputOptions && composerContext && <p className="composer-context-description">Last provider-reported context: {composerContext.detail}.</p>}
        {!userImages && allowAnyFile && attachmentsEnabled && composerDraftStore && <button type="button" className="status-bar-btn" disabled={composerDisabled} onClick={() => {
          pasteNextAsTextRef.current = pickerViewRef.current; setPasteNextAsTextView(pickerViewRef.current);
          if (composerOptionsRef.current) composerOptionsRef.current.open = false;
          setComposerOptionsOpen(false);
          composerInputRef.current?.focus();
        }}>Paste next as text</button>}
        {showAutocorrectToggle && (
          <button
            type="button"
            className={`status-bar-btn ${autocorrectEnabled ? 'active' : ''}`}
            onClick={toggleAutocorrect}
            aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
            title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
          >
            {compactInputOptions ? <span>Spelling: {autocorrectEnabled ? 'On' : 'Off'}</span> : <span className="status-spelling-label">ABC</span>}
          </button>
        )}

        {showMicButtons && (
          <>
            <TerminalMicButton
              key={`local-${sessionId}`}
              sessionId={sessionId}
              provider="local"
              available={voiceAvailable}
              inline
              showLabel={compactInputOptions}
              disclosureOpen={composerOptionsOpen}
              onStateChange={handleLocalVoiceState}
              disabled={composerDisabled || isPastingImage || (voiceBusy && activeVoice[0] !== 'local')}
              onTranscript={handleComposerTranscript}
            />
            <TerminalMicButton
              key={`groq-${sessionId}`}
              sessionId={sessionId}
              provider="groq"
              available={voiceAvailable}
              inline
              showLabel={compactInputOptions}
              disclosureOpen={composerOptionsOpen}
              onStateChange={handleGroqVoiceState}
              disabled={composerDisabled || isPastingImage || (voiceBusy && activeVoice[0] !== 'groq')}
              onTranscript={handleComposerTranscript}
            />
          </>
        )}
          {compactInputOptions && sessionContext}
          {compactInputOptions && composerSecondaryAction}
</div>
        </details> : <>        {showAutocorrectToggle && (
          <button
            type="button"
            className={`status-bar-btn ${autocorrectEnabled ? 'active' : ''}`}
            onClick={toggleAutocorrect}
            aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
            title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
          >
            <span className="status-spelling-label">ABC</span>
          </button>
        )}

        {showMicButtons && (
          <>
            <TerminalMicButton
              key={`local-${sessionId}`}
              sessionId={sessionId}
              provider="local"
              available={voiceAvailable}
              inline
              disabled={composerDisabled || isPastingImage || (voiceBusy && activeVoice[0] !== 'local')}
              onStateChange={handleLocalVoiceState}
              onTranscript={handleComposerTranscript}
            />
            <TerminalMicButton
              key={`groq-${sessionId}`}
              sessionId={sessionId}
              provider="groq"
              available={voiceAvailable}
              inline
              disabled={composerDisabled || isPastingImage || (voiceBusy && activeVoice[0] !== 'groq')}
              onStateChange={handleGroqVoiceState}
              onTranscript={handleComposerTranscript}
            />
          </>
        )}
</>}
        {!compactInputOptions && composerSecondaryAction}
        {!compactInputOptions && sessionContext}
        <div className="status-composer-submit-actions" role="group" aria-label="Message actions">
        {showStop && <button
          type="button"
          className={`status-bar-btn status-response-stop${requiresCleanup && !isInterrupting ? ' status-response-retry' : ''}`}
          disabled={!onInterrupt || isInterrupting}
          onClick={() => onInterrupt?.()}
          aria-label={stopLabel}
          title={stopLabel}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          {requiresCleanup && !isInterrupting && <span>Retry cancellation</span>}
        </button>}
        {(!showStop || canSubmitComposer) && <button
          type="submit"
          className={`status-send-btn ${canSubmitComposer ? '' : 'disabled'}`}
          disabled={!canSubmitComposer}
          aria-label={composerSubmitLabel}
          title={composerSubmitLabel}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5m-6 6 6-6 6 6" />
          </svg>
        </button>}
        </div>
        </div>
      </form>


    </div>
  );
}
