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
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
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
const getAuthScopeKey = () => JSON.stringify(captureAuthScope());

function suppliedFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  if (files.length) return files;
  return Array.from(dataTransfer?.items || []).filter(item => item?.kind === 'file' && typeof item.getAsFile === 'function')
    .map(item => item.getAsFile()).filter(Boolean);
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
  mentionFiles: providedMentionFiles,
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
}) {
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const isMobile = useMobileDetect();
  const composerInputRef = useRef(null);
  const transcriptDraftRef = useRef(null);
  transcriptDraftRef.current = { sessionId, composerValue, onComposerChange };
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
  }, [composerValue, isMobile]);
  const {
    handleKeyDown: autocorrectKeyDown,
    handleSelectionChange: handleAutocorrectSelectionChange
  } = useAutocorrectInput(
    composerValue,
    (nextValue) => onComposerChange?.(typeof nextValue === 'function' ? nextValue(composerValue) : nextValue),
    autocorrectEnabled
  );
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [isProviderAuthOpen, setIsProviderAuthOpen] = useState(false);
  const [isPastingImage, setIsPastingImage] = useState(false);
  const [isPreparingLegacyImage, setIsPreparingLegacyImage] = useState(false);
  const legacyImageWorkRef = useRef(null);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [imageActionError, setImageActionError] = useState(null);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const aiMenuRef = useRef(null);
  const imageInputRef = useRef(null);
  const [restoreOpening, setRestoreOpening] = useState(null);
  const pickerSequence = useRef(0);
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const authScopeKey = useSyncExternalStore(subscribeAuth, getAuthScopeKey);
  const pickerView = useMemo(() => ({}), [sessionId, userImages?.scopeKey, userImages?.generation, environmentSignal, authScopeKey]);
  const pickerViewRef = useRef(pickerView), pickerLeaseRef = useRef(null);
  if (pickerViewRef.current !== pickerView) { pickerLeaseRef.current = null; pickerViewRef.current = pickerView; }
  const imageViewRef = useRef(null);
  const mountedRef = useRef(true);
  const compositionRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    setIsPastingImage(false); setUploadError(''); setIsImageDragOver(false);
    setIsPreparingLegacyImage(Boolean(legacyImageWorkRef.current?.view === pickerView && legacyImageWorkRef.current.pending > 0));
    compositionRef.current = false;
  }, [pickerView]);
  imageViewRef.current = { userImages, sessionId, disabled: composerDisabled, attachmentsEnabled, attachmentsDisabledMessage, onComposerAttachmentAdd };
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
    const view = userImages;
    if (!sameImageView(view) || imageViewRef.current.disabled || !imageScopeMatches) return;
    setImageActionError(null);
    try {
      if (typeof view[action] !== 'function') throw new Error('This image action is unavailable.');
      await view[action](...args);
    } catch (error) {
      if (sameImageView(view)) setImageActionError({ scopeKey: view.scopeKey, generation: view.generation,
        message: String(error?.message || 'Image action failed. Your draft was kept.').slice(0, 400) });
    }
  }

  async function addOwnedFiles(files, source) {
    if (!canAddUserImages || !sameImageView(userImages)) return;
    if (!files.length) {
      setImageActionError({ scopeKey: userImages.scopeKey, generation: userImages.generation, message: 'Choose PNG, JPEG, GIF or WebP image files to attach.' });
      return;
    }
    await imageAction('addFiles', files, { source });
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
  const activeMention = mentionRoot ? mentionQuery(composerValue) : null;
  const fetchedMentionFiles = useFileMentions(providedMentionFiles ? '' : mentionRoot, activeMention);
  const mentionFiles = providedMentionFiles ?? fetchedMentionFiles;
  const slashSuggestions = useMemo(
    () => activeMention != null
      ? mentionFiles.map(file => ({ cmd: `@${file}`, desc: 'File', insert: insertMention(composerValue, file) }))
      : getComposerSlashSuggestions(composerValue, activeRuntimeProviderId, customAiProviders, skills),
    [activeMention, activeRuntimeProviderId, composerValue, customAiProviders, mentionFiles, skills]
  );

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [composerValue, slashSuggestions.length]);

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
    if (composerDisabled || composerSubmitDisabled || isInterrupting || requiresCleanup || voiceBusy) return;
    if (!userImages && (isPreparingLegacyImage || legacyImageWorkRef.current?.view === pickerViewRef.current && legacyImageWorkRef.current.pending > 0)) return;
    if (userImages) {
      if (!canSubmitComposer || !sameImageView(userImages)) return;
      onComposerSubmit?.(typeof submittedValue === 'string' ? submittedValue : '');
      return;
    }
    if (!attachmentsEnabled && composerAttachments.length) { setUploadError('Remove attachments before sending this conversation.'); return; }
    const nextValue = typeof submittedValue === 'string' ? submittedValue : '';
    if (!nextValue.trim() && composerAttachments.length === 0) return;
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
    return false;
  }

  async function attachImageFile(file, fallbackName = 'image.png', scope = captureLegacyImageScope()) {
    if (!file || rejectLegacyImageMutation(scope)) return;

    setUploadError('');
    setIsPastingImage(true);
    const work = beginLegacyImageWork(scope);
    try {
      const path = allowAnyFile && !file.type?.startsWith('image/') ? await uploadAttachment(file) : await uploadScreenshot(file);
      if (!path || rejectLegacyImageMutation(scope)) return;
      imageViewRef.current.onComposerAttachmentAdd?.({
        name: file.name || fallbackName,
        path
      });
    } catch (error) {
      if (!isLegacyImageScopeCurrent(scope)) return;
      const message = error instanceof Error && error.message
        ? error.message
        : 'Image upload failed';
      setUploadError(message);
      console.error('Failed to attach image from composer:', error);
    } finally {
      if (mountedRef.current && legacyImageWorkRef.current === work && work.view === pickerViewRef.current) setIsPastingImage(false);
      finishLegacyImageWork(work);
    }
  }

  function hasFileDrag(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    return types.includes('Files') || types.includes('public.file-url');
  }

  function handleGitBranchChange(event) {
    const nextBranch = typeof event === 'string' ? event : event?.target?.value;
    if (!nextBranch) return;
    onSelectGitBranch?.(nextBranch);
  }

  function handleComposerKeyDown(event) {
    if (compositionRef.current || event.isComposing || event.nativeEvent?.isComposing
      || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) return;
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
        if (suggestion.insert) onComposerChange?.(suggestion.insert);
        else handleComposerSubmit(event, suggestion.cmd);
        return;
      }

      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        onComposerChange?.(slashSuggestions[selectedSlashIndex].insert ?? `${slashSuggestions[selectedSlashIndex].cmd} `);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleComposerSubmit(event, userImages ? composerValue : event.currentTarget?.value ?? composerValue);
    }
  }

  async function handleComposerPaste(event) {
    const scope = captureLegacyImageScope();
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    if (userImages) {
      const files = suppliedFiles(clipboardData);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      if (!canAddUserImages || !sameImageView(userImages)) return;
      const pasted = clipboardData.getData?.('text/plain');
      if (pasted && typeof pasted === 'string') {
        const start = rawTextOffset(composerValue, event.currentTarget.selectionStart ?? composerValue.length);
        const end = rawTextOffset(composerValue, event.currentTarget.selectionEnd ?? composerValue.length);
        onComposerChange?.(composerValue.slice(0, start) + pasted + composerValue.slice(end));
      }
      await addOwnedFiles(files, 'paste');
      return;
    }

    const work = beginLegacyImageWork(scope);
    try {
      const imageFile = await getImageFileFromDataTransfer(clipboardData);
      if (!imageFile || !isLegacyImageScopeCurrent(scope)) return;
      event.preventDefault();
      event.stopPropagation();
      await attachImageFile(imageFile, 'image.png', scope);
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
    if (lease.purpose === 'restore_original') {
      if (lease.binding !== pickerBindingRef.current || !sameOriginalRow(lease.request) || files.length !== 1) return;
      await imageAction('selectOriginalImage', files[0], lease.request); return;
    }
    if (userImages) {
      if (files.length) await addOwnedFiles(files, 'picker');
      return;
    }
    if (files[0]) await attachImageFile(files[0], 'image.png', lease.legacyScope || captureLegacyImageScope());
  }

  function handleComposerDragOver(event) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (userImages ? !canAddUserImages : !attachmentsEnabled) {
      setIsImageDragOver(false);
      if (!userImages) setUploadError(attachmentsDisabledMessage);
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
    if (userImages) { await addOwnedFiles(suppliedFiles(event.dataTransfer), 'drop'); return; }

    const work = beginLegacyImageWork(scope);
    try {
      const imageFile = await getImageFileFromDataTransfer(event.dataTransfer);
      if (!isLegacyImageScopeCurrent(scope)) return;
      if (!imageFile) {
        setUploadError('Drop an image file to attach it.');
        return;
      }
      await attachImageFile(imageFile, 'image.png', scope);
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
    && !voiceBusy
    && !isInterrupting && !requiresCleanup
    && (userImages || !isPreparingLegacyImage)
    && (userImages ? canSendUserImages : attachmentsEnabled || composerAttachments.length === 0)
    && (Boolean(composerValue.trim()) || (userImages ? imageItems.length > 0 : composerAttachments.length > 0))
    && typeof onComposerSubmit === 'function';
  const showStop = isStreaming || isInterrupting || requiresCleanup;
  const stopLabel = isInterrupting ? 'Stopping response' : requiresCleanup ? 'Retry cancellation' : 'Stop response';

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
        className={`status-composer-shell${composerDisabled ? ' disabled' : ''}${isImageDragOver ? ' image-drag-over' : ''}`}
        onSubmit={handleComposerSubmit}
        onClick={event => {
          if (event.target === event.currentTarget && !composerDisabled) composerInputRef.current?.focus();
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
        {!userImages && isPastingImage && <p className="status-composer-upload-status" role="status">Uploading image…</p>}
        {slashSuggestions.length > 0 && (
          <div className="status-slash-menu" role="listbox" aria-label={activeMention != null ? 'File mentions' : 'Slash commands'}>
            {slashSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.cmd}
                type="button"
                role="option"
                aria-selected={index === selectedSlashIndex ? 'true' : 'false'}
                className={`status-slash-option${index === selectedSlashIndex ? ' selected' : ''}`}
                onClick={() => {
                  onComposerChange?.(suggestion.insert ?? `${suggestion.cmd} `);
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
          value={composerValue}
          onChange={(event) => onComposerChange?.(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          onCompositionStart={() => { compositionRef.current = true; }}
          onCompositionEnd={() => { compositionRef.current = false; }}
          onSelect={handleAutocorrectSelectionChange}
          onPaste={handleComposerPaste}
          placeholder={composerPlaceholder}
          aria-label="Command composer"
          rows={1}
          enterKeyHint={isMobile ? 'enter' : 'send'}
          autoComplete="off"
          autoCorrect={autocorrectEnabled ? 'on' : 'off'}
          autoCapitalize={autocorrectEnabled ? 'sentences' : 'off'}
          spellCheck={autocorrectEnabled}
          disabled={composerDisabled || (!userImages && isPastingImage)}
        />
        <input
          key={currentRestoreOpening ? `restore-${currentRestoreOpening.id}` : 'add'}
          ref={imageInputRef}
          type="file"
          accept={userImages ? OWNED_IMAGE_INPUT_ACCEPT : allowAnyFile ? undefined : IMAGE_INPUT_ACCEPT}
          multiple={Boolean(userImages) && !currentRestoreOpening}
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
            disabled={userImages ? !canAddUserImages : composerDisabled || isPastingImage || !attachmentsEnabled}
            aria-label={allowAnyFile && !userImages ? 'Attach file' : 'Add image'}
            title={allowAnyFile && !userImages ? 'Attach file' : 'Add image'}
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
        {compactConversation || compactInputOptions ? <details className="composer-input-options" ref={composerOptionsRef} onToggle={event => setComposerOptionsOpen(event.currentTarget.open)} onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          setComposerOptionsOpen(false);
          event.currentTarget.querySelector('summary')?.focus();
        }}>
          <summary aria-label={compactInputOptions ? 'More composer actions' : 'Input options'} title={compactInputOptions ? 'Dictation, spelling and session actions' : 'Dictation and spelling'}
            onClick={event => {
              event.preventDefault();
              const details = composerOptionsRef.current;
              if (!details) return;
              details.open = !details.open;
              setComposerOptionsOpen(details.open);
            }}>
            {compactInputOptions ? <span aria-hidden="true">···</span> :
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="21" />
            </svg>}
          </summary>
          <div className="composer-input-options-menu">        {showAutocorrectToggle && (
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
