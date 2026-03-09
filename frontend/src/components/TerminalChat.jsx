import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch, uploadScreenshot } from '../utils/api';
import {
  getImageFileFromClipboardItems,
  getImageFileFromDataTransfer,
  hasMeaningfulClipboardText,
  shouldPreferImageOverText
} from '../utils/clipboardImage';
import { getAccessToken, isAccessTokenExpired, refreshTokens } from '../utils/auth';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { useFaviconFlash } from '../hooks/useFaviconFlash';
import { useTouchGestures } from '../hooks/useTouchGestures';
import { useImageUpload } from '../hooks/useImageUpload';
import { useTerminalScrolling } from '../hooks/useTerminalScrolling';
import { useIdleDetection } from '../hooks/useIdleDetection';
import { TerminalHistoryModal } from './TerminalHistoryModal';
import { useTerminalBuffer } from '../hooks/useTerminalBuffer';
import { ReaderView } from './ReaderView';
import { useTheme } from '../contexts/ThemeContext';
import { normalizeCliEventFromMeta } from '../utils/cliEventContract';
import { cliEventIndicatesTerminalIdle, outputIndicatesTerminalIdle } from '../utils/terminalBusyState';
import { isTerminalControlResponseInput } from '../utils/terminalControlInput';
import { getTerminalTheme } from '../utils/terminalTheme';
import {
  createExternalInputFrames,
  prepareTerminalForExternalInput,
} from '../utils/terminalExternalInput';
import { rewriteTerminalAgentInput } from '../utils/aiProviders';
import { resolveTerminalWebglEnabled } from '../utils/terminalRendererPolicy';
import { getTerminalPlatformConfig, resolveTerminalSurface } from '../utils/terminalSurface';

// Static ANSI 256-colour palette — built once at module load, not per render frame.
const DEFAULT_ANSI_PALETTE = (() => {
  const base = [
    '#2e3436', '#cc0000', '#4e9a06', '#c4a000',
    '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f',
    '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
  ];
  const palette = base.slice();
  const steps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const toHex = (v) => v.toString(16).padStart(2, '0');
  for (let i = 0; i < 216; i++) {
    const r = steps[Math.floor(i / 36) % 6];
    const g = steps[Math.floor(i / 6) % 6];
    const b = steps[i % 6];
    palette.push(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
  }
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10;
    palette.push(`#${toHex(c)}${toHex(c)}${toHex(c)}`);
  }
  return palette;
})();

function isLikelyShellCommandPreview(line) {
  return /^(cd|ls|pwd|git|npm|pnpm|yarn|bun|node|python|pip|cargo|go|make|bash|sh|zsh|cat|rg|grep|sed|awk|jq|chmod|chown|mv|cp|rm|mkdir|touch|code|vi|vim|nano|clear)\b/i.test(line);
}

function toPreviewCandidate(line) {
  if (typeof line !== 'string') return null;
  const text = line.replace(/\s+/g, ' ').trim();
  if (text.length < 8 || text.length > 200) return null;
  if (!/\s/.test(text)) return null;
  if (/^[./~]/.test(text) || /^https?:\/\//.test(text)) return null;
  if (/^\/\w+/.test(text)) return null; // CLI slash commands like /model
  if (isLikelyShellCommandPreview(text)) return null;
  const letters = (text.match(/[A-Za-z ]/g) ?? []).length;
  if (letters / text.length < 0.5) return null;
  return text.slice(0, 120);
}

function extractCompletedLinesFromTerminalInputChunk(chunk, state) {
  if (!chunk || typeof chunk !== 'string') return [];
  const lines = [];
  let line = state.current || '';

  // Remove common terminal escape sequences before processing typed characters.
  const cleaned = chunk
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')      // CSI
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[@-_]/g, '');                    // other short escapes

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '\r' || ch === '\n') {
      if (line.trim()) lines.push(line);
      line = '';
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1);
      continue;
    }
    if (ch === '\t') {
      line += ' ';
      continue;
    }
    if (ch < ' ' || ch === '\x7f') {
      continue;
    }
    line += ch;
  }

  state.current = line;
  return lines;
}

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, webglEnabled, onScrollDirection, onViewportStateChange, onRegisterImageUpload, onRegisterHistoryPanel, onRegisterSelectionActions, onRegisterFocusTerminal, onRegisterSendText, onRegisterScrollToBottom, onActivityChange, onConnectionChange, onCwdChange, onSendMessage, onOutputChunk, onScreenSnapshot, onTurn, onCliEvent, usesTmux, fitSignal, viewMode = 'terminal', isPrimary = false, skipHistory = false, syncPtySize = true, surface }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const webglAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const touchScrollAccRef = useRef(0);
  const touchVelocityRef = useRef(0);   // px/ms, for momentum
  const touchLastTimeRef = useRef(0);
  const momentumAnimRef = useRef(null);
  const clientIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const inputFlushRef = useRef(null);
  const mobileInputRef = useRef(null);
  const { theme } = useTheme();
  const detectedIsMobile = useMobileDetect();
  const terminalSurface = useMemo(
    () => resolveTerminalSurface(surface, detectedIsMobile),
    [surface, detectedIsMobile]
  );
  const platformConfig = useMemo(
    () => getTerminalPlatformConfig({
      surface: terminalSurface,
      fontSize,
      webglEnabled: resolveTerminalWebglEnabled(webglEnabled),
    }),
    [fontSize, terminalSurface, webglEnabled]
  );
  const isMobile = platformConfig.isMobile;
  const isIOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  const performanceMode = true;
  const USE_FRAMED_PROTOCOL = true;
  const MAX_PENDING_WRITE_CHARS = 1_000_000;
  const MAX_MESSAGE_QUEUE = 500;
  const DROP_NOTICE_INTERVAL_MS = 5000;
  const LARGE_PASTE_THRESHOLD = 5000;
  const { activeSessionId, sessions, restoreSession, registerTerminalSender, unregisterTerminalSender, updateSessionTopic, syncSessionThread } = useTerminalSession();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [isScrollMode, setIsScrollMode] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [isCopyMode, setIsCopyMode] = useState(false);
  const [ptyOwnerState, setPtyOwnerState] = useState({
    isOwner: null,
    ownerClientId: null,
    appliedCols: null,
    appliedRows: null
  });
  const [showCopiedBanner, setShowCopiedBanner] = useState(false);
  const copiedBannerTimerRef = useRef(null);
  const { buffer: readerBuffer, append: appendToReader, clear: clearReader, replace: replaceReaderBuffer } = useTerminalBuffer();
  const [readerLines, setReaderLines] = useState(null);
  const [readerLineHeight, setReaderLineHeight] = useState(null);
  const readerLineHeightRef = useRef(null);
  const [readerScrollToken, setReaderScrollToken] = useState(0);
  const sendTerminalInputRef = useRef(null);
  const pendingExternalInputRef = useRef([]);
  const enqueueExternalInputRef = useRef(null);
  const externalInputFramesRef = useRef([]);
  const externalInputTimerRef = useRef(null);
  const nextExternalInputAtRef = useRef(0);
  const fitTimeoutRef = useRef(null);
  const fitRafRef = useRef(null);
  const pendingFitOptionsRef = useRef(null);
  const requestAuthoritativeResizeRef = useRef(null);
  const requestPriorityResizeRef = useRef(null);
  const onScrollDirectionRef = useRef(onScrollDirection);
  const onViewportStateChangeRef = useRef(onViewportStateChange);
  const onSendMessageRef = useRef(onSendMessage);
  const onOutputChunkRef = useRef(onOutputChunk);
  const onActivityChangeRef = useRef(onActivityChange);
  const onScreenSnapshotRef = useRef(onScreenSnapshot);
  const onCliEventRef = useRef(onCliEvent);
  const usesTmuxRef = useRef(Boolean(usesTmux));
  const webglEnabledRef = useRef(platformConfig.webglEnabled);
  const scrollModeRef = useRef(false);
  const viewModeRef = useRef(viewMode);
  const isPrimaryRef = useRef(isPrimary);
  const syncPtySizeRef = useRef(syncPtySize !== false);
  const ptyOwnerStateRef = useRef({
    isOwner: null,
    ownerClientId: null,
    appliedCols: null,
    appliedRows: null
  });
  const pendingServerSeqRef = useRef(null);
  const lastServerSeqRef = useRef(0);
  const pendingOwnerPromotionRef = useRef(false);
  const ownerPromotionDeadlineRef = useRef(0);
  const ownerPromotionTimerRef = useRef(null);
  const readerSyncRef = useRef(null);
  const droppedOutputRef = useRef(0);
  const droppedEventCountRef = useRef(0);
  const tailModeRef = useRef(false);
  const lastDropNoticeAtRef = useRef(0);
  const MIN_FIT_CONTAINER_WIDTH = 50;
  const MIN_FIT_CONTAINER_HEIGHT = 30;
  const historyStateRef = useRef({
    pageEvents: platformConfig.history.pageEvents,
    pageChars: platformConfig.history.pageChars,
    maxHistoryEvents: platformConfig.history.maxEvents,
    maxHistoryChars: platformConfig.history.maxChars,
    exhausted: false,
    loading: false,
    lastCount: 0,
    lastChars: 0,
    lastLoadAt: 0,
    oldestTs: null,
    newestTs: null,
    oldestSeq: null,
    newestSeq: null
  });
  const historyEntriesRef = useRef([]);
  const historyTextRef = useRef('');
  const historyCharCountRef = useRef(0);
  const historyReloadingRef = useRef(false);
  const pendingSocketDataRef = useRef([]);
  const loadMoreHistoryRef = useRef(null);
  const shouldReplayHistoryRef = useRef(true);
  const reconnectSocketRef = useRef(null);
  const pausedForOfflineRef = useRef(false);
  const lastServerPingAtRef = useRef(0);
  const sessionsRef = useRef(sessions);
  const restoreSessionRef = useRef(restoreSession);
  const updateSessionTopicRef = useRef(updateSessionTopic);
  const previewInputLineRef = useRef('');
  const lastAutoPreviewRef = useRef({ sessionId: null, value: '' });
  const screenSnapshotFrameRef = useRef(null);
  const lastScreenSnapshotRef = useRef('');
  const restoreRetryAttemptedRef = useRef(false);
  const restoreAttempt2Ref = useRef(false);
  const idlePromptProbeRef = useRef('');
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isActiveSession = sessionId === activeSessionId;
  const getHistoryConfig = useCallback(() => ({
    pageEvents: platformConfig.history.pageEvents,
    pageChars: platformConfig.history.pageChars,
    maxEvents: platformConfig.history.maxEvents,
    maxChars: platformConfig.history.maxChars
  }), [platformConfig]);

  const applyHistoryConfig = useCallback(() => {
    const config = getHistoryConfig();
    historyStateRef.current.pageEvents = config.pageEvents;
    historyStateRef.current.pageChars = config.pageChars;
    historyStateRef.current.maxHistoryEvents = config.maxEvents;
    historyStateRef.current.maxHistoryChars = config.maxChars;
  }, [getHistoryConfig]);

  const reflectIdlePromptState = useCallback((text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    idlePromptProbeRef.current = `${idlePromptProbeRef.current}${text}`.slice(-512);
    if (outputIndicatesTerminalIdle(idlePromptProbeRef.current)) {
      onActivityChangeRef.current?.(false);
    }
  }, []);

  const resetHistoryCache = useCallback(() => {
    historyEntriesRef.current = [];
    historyTextRef.current = '';
    historyCharCountRef.current = 0;
    historyStateRef.current.lastCount = 0;
    historyStateRef.current.lastChars = 0;
    historyStateRef.current.oldestTs = null;
    historyStateRef.current.newestTs = null;
    historyStateRef.current.oldestSeq = null;
    historyStateRef.current.newestSeq = null;
    lastServerSeqRef.current = 0;
    pendingServerSeqRef.current = null;
  }, []);

  const getEntrySeq = useCallback((entry) => {
    if (!entry) return null;
    const seq = Number(entry.seq);
    return Number.isFinite(seq) && seq > 0 ? seq : null;
  }, []);

  const updateHistoryText = useCallback((removedChars = 0) => {
    if (removedChars > 0) {
      historyTextRef.current = historyTextRef.current.slice(removedChars);
      return;
    }
    historyTextRef.current = historyEntriesRef.current.map((entry) => entry.text).join('');
  }, []);

  const trimHistoryEntries = useCallback(() => {
    const state = historyStateRef.current;
    const entries = historyEntriesRef.current;
    let removedChars = 0;

    if (state.maxHistoryEvents && entries.length > state.maxHistoryEvents) {
      const removeCount = entries.length - state.maxHistoryEvents;
      const removed = entries.splice(0, removeCount);
      removedChars += removed.reduce((sum, entry) => sum + (entry?.text?.length || 0), 0);
      historyCharCountRef.current -= removedChars;
    }

    if (state.maxHistoryChars && historyCharCountRef.current > state.maxHistoryChars) {
      while (entries.length > 1 && historyCharCountRef.current > state.maxHistoryChars) {
        const removed = entries.shift();
        if (!removed) break;
        const removedLength = removed?.text?.length || 0;
        removedChars += removedLength;
        historyCharCountRef.current -= removedLength;
      }
    }

    if (removedChars > 0) {
      updateHistoryText(removedChars);
    }

    state.lastCount = entries.length;
    state.lastChars = historyCharCountRef.current;
    state.oldestTs = entries[0]?.ts ?? null;
    state.newestTs = entries.length > 0 ? entries[entries.length - 1]?.ts ?? null : null;
    state.oldestSeq = getEntrySeq(entries[0]);
    state.newestSeq = entries.length > 0 ? getEntrySeq(entries[entries.length - 1]) : null;
    if (state.newestSeq) {
      lastServerSeqRef.current = Math.max(lastServerSeqRef.current, state.newestSeq);
    }
  }, [getEntrySeq, updateHistoryText]);

  const setHistoryEntries = useCallback((entries) => {
    historyEntriesRef.current = entries;
    historyCharCountRef.current = entries.reduce((sum, entry) => sum + (entry?.text?.length || 0), 0);
    updateHistoryText();
    historyStateRef.current.lastCount = entries.length;
    historyStateRef.current.lastChars = historyCharCountRef.current;
    historyStateRef.current.oldestTs = entries[0]?.ts ?? null;
    historyStateRef.current.newestTs = entries.length > 0 ? entries[entries.length - 1]?.ts ?? null : null;
    historyStateRef.current.oldestSeq = getEntrySeq(entries[0]);
    historyStateRef.current.newestSeq = entries.length > 0 ? getEntrySeq(entries[entries.length - 1]) : null;
    if (historyStateRef.current.newestSeq) {
      lastServerSeqRef.current = Math.max(lastServerSeqRef.current, historyStateRef.current.newestSeq);
    }
  }, [getEntrySeq, updateHistoryText]);

  const appendHistoryEntry = useCallback((entry) => {
    if (!entry?.text) return;
    historyEntriesRef.current.push(entry);
    historyCharCountRef.current += entry.text.length;
    historyTextRef.current += entry.text;
    historyStateRef.current.newestTs = entry.ts ?? historyStateRef.current.newestTs;
    const nextSeq = getEntrySeq(entry);
    if (nextSeq) {
      historyStateRef.current.newestSeq = nextSeq;
      lastServerSeqRef.current = Math.max(lastServerSeqRef.current, nextSeq);
      if (!historyStateRef.current.oldestSeq) {
        historyStateRef.current.oldestSeq = nextSeq;
      }
    }
    trimHistoryEntries();
  }, [getEntrySeq, trimHistoryEntries]);

  const prependHistoryEntries = useCallback((entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const prefixText = entries.map((entry) => entry.text || '').join('');
    historyEntriesRef.current = [...entries, ...historyEntriesRef.current];
    historyCharCountRef.current += prefixText.length;
    historyTextRef.current = prefixText + historyTextRef.current;
    trimHistoryEntries();
  }, [trimHistoryEntries]);
  const triggerLoadMoreIfAtTop = useCallback(() => {
    const term = xtermRef.current;
    const loadMore = loadMoreHistoryRef.current;
    if (!term || !loadMore) return;
    const buffer = term.buffer?.active;
    if (!buffer || buffer.type === 'alternate') return;
    if (buffer.viewportY === 0) {
      loadMore();
    }
  }, []);

  // Send data to terminal via WebSocket
  const sendToTerminal = useCallback((data) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }, []);

  // Favicon flashing
  const { startFaviconFlash, stopFaviconFlash } = useFaviconFlash(isActiveSession);

  // Idle detection with audio feedback
  const {
    hasUserInputRef,
    markUserInput,
    resetUserInput,
    resetIdleTimer,
    cleanup: cleanupIdle
  } = useIdleDetection({ onActivityChange, startFaviconFlash, stopFaviconFlash });

  // Terminal scrolling with tmux copy-mode support
  const {
    inCopyModeRef,
    isScrollingRef,
    scrollUp,
    scrollDown,
    scrollInTmux,
    sendCopyModeKeys,
    scrollByLines,
    scrollByWheel,
    jumpToLive,
    startScrolling,
    stopScrolling,
    exitCopyModeIfActive,
    resetCopyModeState,
    cleanup: cleanupScrolling
  } = useTerminalScrolling(xtermRef, sendToTerminal, usesTmuxRef, { onCopyModeChange: setIsCopyMode });

  // Mobile keyboard input handler - forwards keystrokes to terminal
  const handleMobileInput = useCallback((e) => {
    const value = e.target.value;
    if (value && sendTerminalInputRef.current) {
      sendTerminalInputRef.current(value);
    }
    e.target.value = ''; // Clear after sending
  }, []);

  // Mobile paste handler - intercepts paste events on the invisible input overlay
  const handleMobilePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text');
    if (!text || !sendTerminalInputRef.current) return;
    if (text.length > LARGE_PASTE_THRESHOLD && !window.confirm(`Paste ${text.length} characters into the terminal?`)) return;
    sendTerminalInputRef.current(`\x1b[200~${text}\x1b[201~`);
  }, []);

  const handleMobileKeyDown = useCallback((e) => {
    if (!sendTerminalInputRef.current) return;
    // Handle special keys
    if (e.key === 'Enter') {
      e.preventDefault();
      sendTerminalInputRef.current('\r');
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      sendTerminalInputRef.current('\x7f');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      sendTerminalInputRef.current('\t');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      sendTerminalInputRef.current('\x1b');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sendTerminalInputRef.current('\x1b[A');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      sendTerminalInputRef.current('\x1b[B');
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      sendTerminalInputRef.current('\x1b[D');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      sendTerminalInputRef.current('\x1b[C');
    }
  }, []);

  // Mobile keyboard control - now also focuses the mobile input
  const setMobileInputEnabled = useCallback((enabled) => {
    if (!isMobile) return;
    if (enabled) {
      // Focus the mobile input to trigger iOS keyboard
      setTimeout(() => mobileInputRef.current?.focus(), 50);
    } else {
      mobileInputRef.current?.blur();
    }
  }, [isMobile]);

  const setScrollMode = useCallback((enabled, options = {}) => {
    scrollModeRef.current = enabled;
    setIsScrollMode(enabled);
    if (!isMobile) return;
    if (enabled) {
      setMobileInputEnabled(false);
      return;
    }
    if (options.jumpToLive) {
      if (viewModeRef.current === 'reader') {
        setReaderScrollToken((value) => value + 1);
        onViewportStateChangeRef.current?.(true);
      } else {
        jumpToLive();
        onViewportStateChangeRef.current?.(true);
      }
    }
    setMobileInputEnabled(true);
  }, [isMobile, jumpToLive, setMobileInputEnabled]);

  const toggleScrollMode = useCallback(() => {
    setScrollMode(!scrollModeRef.current);
  }, [setScrollMode]);

  // Image upload handling
  const {
    imageDragOver,
    imageInputRef,
    handleImageDrop,
    handleDragOver,
    handleDragLeave,
    handleImageSelect,
    triggerFileInput
  } = useImageUpload((path) => {
    if (sendTerminalInputRef.current) {
      sendTerminalInputRef.current(path);
    }
  });

  // Handler for reader view keyboard input
  const handleReaderInput = useCallback((data) => {
    if (!data) return;
    if (sendTerminalInputRef.current) {
      sendTerminalInputRef.current(data);
    } else {
      // Fallback: send directly if ref not ready yet
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        return;
      }
      apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: data }
      }).catch((error) => {
        console.error('Failed to send terminal input:', error);
      });
    }
  }, [sessionId]);

  const handleReaderLoadMore = useCallback(() => {
    loadMoreHistoryRef.current?.();
  }, []);

  const showCopiedFeedback = useCallback(() => {
    setShowCopiedBanner(true);
    if (copiedBannerTimerRef.current) {
      clearTimeout(copiedBannerTimerRef.current);
    }
    copiedBannerTimerRef.current = setTimeout(() => {
      setShowCopiedBanner(false);
      copiedBannerTimerRef.current = null;
    }, 1500);
  }, []);

  const fallbackCopyText = useCallback((text) => {
    if (typeof document === 'undefined' || !document.body || !text) return false;

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  }, []);

  const hasTerminalSelection = useCallback(() => {
    const term = xtermRef.current;
    return Boolean(term && typeof term.hasSelection === 'function' && term.hasSelection());
  }, []);

  const copyTerminalSelection = useCallback(async () => {
    const term = xtermRef.current;
    const selection = term?.getSelection?.() || '';
    if (!selection) return false;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selection);
        showCopiedFeedback();
        return true;
      }
    } catch (error) {
      console.error('Failed to copy terminal selection via clipboard API:', error);
    }

    if (fallbackCopyText(selection)) {
      showCopiedFeedback();
      return true;
    }

    return false;
  }, [fallbackCopyText, showCopiedFeedback]);

  const syncReaderBuffer = useCallback(() => {
    const term = xtermRef.current;
    const buffer = term?.buffer?.active;
    if (!buffer || !term) return;

    const themeColors = term._core?._themeService?.colors;
    const nextLineHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
    if (Number.isFinite(nextLineHeight) && nextLineHeight > 0 && nextLineHeight !== readerLineHeightRef.current) {
      readerLineHeightRef.current = nextLineHeight;
      setReaderLineHeight(nextLineHeight);
    }
    const themeOptions = term.options?.theme || {};
    const defaultFg = themeColors?.foreground?.css || themeOptions.foreground || '#d4d4d4';
    const defaultBg = themeColors?.background?.css || themeOptions.background || '#1e1e1e';
    const defaultFgLower = defaultFg.toLowerCase();
    const defaultBgLower = defaultBg.toLowerCase();

    const ansiPalette = Array.isArray(themeColors?.ansi) && themeColors.ansi.length >= 16
      ? themeColors.ansi.map((color) => color?.css || defaultFg)
      : DEFAULT_ANSI_PALETTE;

    const rgbToCss = (value) => `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;

    const resolveColor = (cell, isForeground) => {
      if (!cell) return isForeground ? defaultFg : defaultBg;
      if (isForeground) {
        if (cell.isFgDefault()) return defaultFg;
        if (cell.isFgRGB()) return rgbToCss(cell.getFgColor());
        if (cell.isFgPalette()) return ansiPalette[cell.getFgColor()] || defaultFg;
      } else {
        if (cell.isBgDefault()) return defaultBg;
        if (cell.isBgRGB()) return rgbToCss(cell.getBgColor());
        if (cell.isBgPalette()) return ansiPalette[cell.getBgColor()] || defaultBg;
      }
      return isForeground ? defaultFg : defaultBg;
    };

    const bufferLineCount = buffer.length;
    const cols = term.cols || 0;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const cursorColumn = Math.min(buffer.cursorX, cols);
    const nullCell = buffer.getNullCell();
    const maxLines = platformConfig.readerMaxLines ?? bufferLineCount;
    const startLine = bufferLineCount > maxLines ? bufferLineCount - maxLines : 0;
    const lines = [];
    let lastNonEmpty = -1;

    for (let i = startLine; i < bufferLineCount; i++) {
      const lineIndex = i - startLine;
      const line = buffer.getLine(i);
      if (!line || cols <= 0) {
        lines.push([]);
        continue;
      }

      const effectiveCursorCol = i === cursorLine ? cursorColumn : null;
      const scanLimit = cols - 1;
      let lastContentCol = -1;
      for (let col = scanLimit; col >= 0; col--) {
        const cell = line.getCell(col, nullCell);
        if (!cell || cell.getWidth() === 0) continue;
        if (cell.getCode() !== 0 || !cell.isAttributeDefault()) {
          lastContentCol = col;
          break;
        }
      }

      const cursorClamp = effectiveCursorCol === null ? -1 : Math.min(effectiveCursorCol, cols - 1);
      const hasVirtualCursor = effectiveCursorCol === cols && cols > 0;
      let maxCol = Math.max(lastContentCol, cursorClamp);

      if (maxCol < 0) {
        lines.push([]);
        continue;
      }

      let currentKey = null;
      let currentSegment = null;
      const segments = [];
      let lineHasContent = false;

      for (let col = 0; col <= maxCol; col++) {
        const cell = line.getCell(col, nullCell);
        if (!cell || cell.getWidth() === 0) {
          continue;
        }

        const isCursor = !hasVirtualCursor && effectiveCursorCol === col;
        const rawChars = cell.getChars();
        const text = rawChars && rawChars.length > 0 ? rawChars : ' ';

        let fg = resolveColor(cell, true);
        let bg = resolveColor(cell, false);
        if (cell.isInverse()) {
          const swap = fg;
          fg = bg;
          bg = swap;
        }

        const style = {};
        let fgKey = '';
        let bgKey = '';
        if (isCursor) {
          style['--cursor-bg'] = fg || defaultFg;
          style['--cursor-fg'] = bg || defaultBg;
          style['--cursor-text'] = fg || defaultFg;
          fgKey = String(style['--cursor-fg']).toLowerCase();
          bgKey = String(style['--cursor-bg']).toLowerCase();
        } else {
          if (cell.isInvisible()) {
            style.color = 'transparent';
            fgKey = 'transparent';
          } else if (fg && fg.toLowerCase() !== defaultFgLower) {
            style.color = fg;
            fgKey = fg.toLowerCase();
          }
          if (bg && bg.toLowerCase() !== defaultBgLower) {
            style.backgroundColor = bg;
            bgKey = bg.toLowerCase();
          }
        }

        const decorations = [];
        if (cell.isUnderline()) decorations.push('underline');
        if (cell.isStrikethrough()) decorations.push('line-through');
        if (cell.isOverline()) decorations.push('overline');
        if (decorations.length > 0) {
          style.textDecoration = decorations.join(' ');
        }

        const styleKey = [
          isCursor ? 'c' : 'n',
          fgKey,
          bgKey,
          cell.isBold() ? 'b' : '',
          cell.isItalic() ? 'i' : '',
          cell.isUnderline() ? 'u' : '',
          cell.isStrikethrough() ? 's' : '',
          cell.isOverline() ? 'o' : '',
          cell.isInvisible() ? 'x' : ''
        ].join('|');

        if (currentKey !== styleKey) {
          if (currentSegment) {
            segments.push(currentSegment);
          }
          currentKey = styleKey;
          currentSegment = {
            text,
            style,
            isCursor
          };
        } else {
          currentSegment.text += text;
        }

        const hasStyle = !isCursor && (
          style.backgroundColor ||
          style.color ||
          style.fontWeight ||
          style.fontStyle ||
          style.textDecoration
        );
        if (isCursor) {
          lineHasContent = true;
        } else if (text.trim() !== '') {
          lineHasContent = true;
        } else if (hasStyle) {
          lineHasContent = true;
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
      }

      if (hasVirtualCursor) {
        segments.push({
          text: ' ',
          style: {
            '--cursor-bg': defaultFg,
            '--cursor-fg': defaultBg,
            '--cursor-text': defaultFg
          },
          isCursor: true
        });
        lineHasContent = true;
      }

      lines.push(segments);
      if (lineHasContent) {
        lastNonEmpty = lineIndex;
      }
    }

    const viewportBottomAbsolute = Math.min(bufferLineCount - 1, buffer.baseY + term.rows - 1);
    const viewportBottom = viewportBottomAbsolute >= startLine ? viewportBottomAbsolute - startLine : -1;
    const cursorLineIndex = cursorLine >= startLine ? cursorLine - startLine : -1;
    const lastLineIndex = Math.max(lastNonEmpty, cursorLineIndex, viewportBottom);
    const visibleLines = lastLineIndex >= 0 ? lines.slice(0, lastLineIndex + 1) : [];
    const textLines = visibleLines.map((lineSegments) => lineSegments.map((segment) => segment.text).join(''));
    replaceReaderBuffer(textLines.join('\n'));
    setReaderLines(visibleLines);
  }, [platformConfig.readerMaxLines, replaceReaderBuffer]);

  const scheduleReaderSync = useCallback(() => {
    if (readerSyncRef.current) return;
    readerSyncRef.current = requestAnimationFrame(() => {
      readerSyncRef.current = null;
      if (viewModeRef.current !== 'reader') return;
      syncReaderBuffer();
    });
  }, [syncReaderBuffer]);

  // Blur xterm terminal when reader view is active to prevent it from capturing keyboard events
  useEffect(() => {
    const term = xtermRef.current;
    if (!term?.textarea) return;

    if (viewMode === 'reader') {
      term.textarea.blur();
    }
  }, [viewMode]);

  // Update terminal colors when theme changes
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const newTheme = getTerminalTheme(theme);
    term.options.theme = newTheme;
    try {
      term.refresh(0, term.rows - 1);
    } catch { /* ignore refresh errors during setup */ }
  }, [theme]);

  const handleTerminalTap = useCallback((event) => {
    if (!isMobile || event?.defaultPrevented) return;
    if (viewMode === 'reader') return;
    const target = event?.target;
    if (target instanceof Element) {
      const inputTarget = target.closest('input');
      if (inputTarget && inputTarget.classList.contains('mobile-keyboard-input')) {
        // Allow overlay input to toggle scroll mode or focus.
      } else if (target.closest('button, input, textarea, select, a')) {
        return;
      }
    }
    if (scrollModeRef.current) {
      setScrollMode(false, { jumpToLive: true });
      return;
    }
    if (isMobile && requestPriorityResizeRef.current) {
      try {
        requestPriorityResizeRef.current();
      } catch {
        // Ignore transient resize/promotion failures during mount/reconnect.
      }
    }
    setMobileInputEnabled(true);
  }, [isMobile, setMobileInputEnabled, setScrollMode, viewMode]);

  // Touch gesture handling - no scroll-mode on mobile (native scroll works better)
  const handleLongPress = useCallback(() => {
    if (!isMobile) return;
    // On mobile, don't enter scroll-mode (touch-action:none blocks all touch scrolling).
    // Scroll buttons are always visible instead.
  }, [isMobile]);

  // Cancel any active momentum animation (e.g. when user touches again)
  const cancelMomentum = useCallback(() => {
    if (momentumAnimRef.current) {
      cancelAnimationFrame(momentumAnimRef.current);
      momentumAnimRef.current = null;
    }
  }, []);

  // Start momentum/fling scroll after finger lifts. Only works for xterm
  // scrollback (baseY > 0) since tmux key sends would be too spammy.
  const startMomentum = useCallback((initialVelocity) => {
    cancelMomentum();
    const FRICTION = 0.93;       // velocity decay per frame (~60fps)
    const MIN_VELOCITY = 0.08;   // px/ms below which we stop
    const lineHeight = 16;
    let velocity = initialVelocity;
    let accPx = 0;

    const tick = () => {
      velocity *= FRICTION;
      if (Math.abs(velocity) < MIN_VELOCITY) {
        momentumAnimRef.current = null;
        return;
      }
      const term = xtermRef.current;
      if (!term) return;
      const baseY = term.buffer?.active?.baseY || 0;
      if (baseY <= 0) {
        momentumAnimRef.current = null;
        return;
      }
      // ~16ms per frame at 60fps
      accPx += velocity * 16;
      if (Math.abs(accPx) >= lineHeight) {
        const lines = Math.floor(Math.abs(accPx) / lineHeight);
        term.scrollLines(velocity > 0 ? -lines : lines);
        accPx -= lines * lineHeight * (velocity > 0 ? 1 : -1);
      }
      momentumAnimRef.current = requestAnimationFrame(tick);
    };

    momentumAnimRef.current = requestAnimationFrame(tick);
  }, [cancelMomentum]);

  const handleTouchMove = useCallback((info) => {
    const term = xtermRef.current;
    if (!term) return;
    const deltaY = info?.deltaY || 0;
    if (!deltaY) return;

    if (isMobile) {
      if (info?.event?.cancelable) {
        info.event.preventDefault();
      }

      // Track velocity for momentum (exponential moving average)
      const now = performance.now();
      const dt = now - touchLastTimeRef.current;
      if (dt > 0 && dt < 200) {
        const rawVelocity = deltaY / dt;
        touchVelocityRef.current = touchVelocityRef.current * 0.6 + rawVelocity * 0.4;
      }
      touchLastTimeRef.current = now;

      const lineHeight = 16;
      const baseY = term.buffer?.active?.baseY || 0;

      if (baseY > 0) {
        // xterm has its own scrollback - fire on every frame for maximum smoothness.
        const lines = Math.max(1, Math.round(Math.abs(deltaY) / lineHeight));
        term.scrollLines(deltaY > 0 ? -lines : lines);
        if (deltaY > 0) triggerLoadMoreIfAtTop();
      } else {
        // tmux manages scrollback (baseY=0). Accumulate touch delta then scroll
        // using arrow keys which work in both vi and emacs copy mode.
        touchScrollAccRef.current += deltaY;
        if (Math.abs(touchScrollAccRef.current) >= lineHeight) {
          const lines = Math.floor(Math.abs(touchScrollAccRef.current) / lineHeight);
          const up = touchScrollAccRef.current > 0;
          scrollByLines(up ? 'up' : 'down', lines);
          touchScrollAccRef.current -= lines * lineHeight * (up ? 1 : -1);
          if (up) triggerLoadMoreIfAtTop();
        }
      }
      return;
    }

    const deltaX = info?.deltaX || 0;
    // Ignore horizontal swipes so session switching keeps working.
    const isVerticalDrag = Math.abs(deltaY) >= Math.abs(deltaX);
    if (!isVerticalDrag) return;

    if (info?.event?.cancelable) {
      info.event.preventDefault();
    }

    // Touch delta direction is opposite wheel delta direction.
    scrollByWheel(-deltaY, 1, term.rows);
    if (deltaY > 0) {
      triggerLoadMoreIfAtTop();
    }
  }, [isMobile, scrollByLines, scrollByWheel, triggerLoadMoreIfAtTop]);

  const {
    touchStateRef,
    handleTouchStartCapture: rawTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture: rawTouchEndCapture,
    handleTouchCancelCapture: rawTouchCancelCapture
  } = useTouchGestures(isMobile, handleTerminalTap, {
    onLongPress: handleLongPress,
    onMove: handleTouchMove
  });

  // Reset accumulators and cancel momentum at gesture start
  const handleTouchStartCapture = useCallback((e) => {
    cancelMomentum();
    touchScrollAccRef.current = 0;
    touchVelocityRef.current = 0;
    touchLastTimeRef.current = performance.now();
    rawTouchStartCapture(e);
  }, [cancelMomentum, rawTouchStartCapture]);

  // On finger lift, kick off momentum if moving fast enough
  const handleTouchEndCapture = useCallback((e) => {
    const velocity = touchVelocityRef.current;
    touchScrollAccRef.current = 0;
    touchVelocityRef.current = 0;
    rawTouchEndCapture(e);
    if (isMobile && Math.abs(velocity) > 0.2) {
      startMomentum(velocity);
    }
  }, [isMobile, rawTouchEndCapture, startMomentum]);

  const handleTouchCancelCapture = useCallback((e) => {
    cancelMomentum();
    touchScrollAccRef.current = 0;
    touchVelocityRef.current = 0;
    rawTouchCancelCapture(e);
  }, [cancelMomentum, rawTouchCancelCapture]);

  // Keep refs updated to avoid stale closures
  useEffect(() => {
    onScrollDirectionRef.current = onScrollDirection;
  }, [onScrollDirection]);

  useEffect(() => {
    onViewportStateChangeRef.current = onViewportStateChange;
  }, [onViewportStateChange]);

  useEffect(() => {
    onSendMessageRef.current = onSendMessage;
  }, [onSendMessage]);

  useEffect(() => {
    onOutputChunkRef.current = onOutputChunk;
  }, [onOutputChunk]);

  useEffect(() => {
    onActivityChangeRef.current = onActivityChange;
  }, [onActivityChange]);

  useEffect(() => {
    onScreenSnapshotRef.current = onScreenSnapshot;
  }, [onScreenSnapshot]);

  useEffect(() => {
    onCliEventRef.current = onCliEvent;
  }, [onCliEvent]);

  const emitScreenSnapshot = useCallback(() => {
    const callback = onScreenSnapshotRef.current;
    const term = xtermRef.current;
    if (typeof callback !== 'function' || !term) return;

    const buffer = term.buffer?.active;
    if (!buffer) return;

    const viewportY = Math.max(0, buffer.viewportY ?? 0);
    const rowCount = Math.max(1, term.rows || 24);
    const lines = [];

    for (let row = 0; row < rowCount; row += 1) {
      const line = buffer.getLine(viewportY + row);
      const text = line ? line.translateToString(true).replace(/\s+$/g, '') : '';
      lines.push(text);
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const text = lines.join('\n');
    const bufferType = buffer.type === 'alternate' ? 'alternate' : 'normal';
    const signature = `${bufferType}:${text}`;
    if (signature === lastScreenSnapshotRef.current) return;
    lastScreenSnapshotRef.current = signature;

    callback({
      text,
      bufferType,
      rows: rowCount,
      cols: term.cols || 0,
      ts: Date.now()
    });
  }, []);

  const scheduleScreenSnapshot = useCallback(() => {
    if (typeof requestAnimationFrame !== 'function') {
      emitScreenSnapshot();
      return;
    }
    if (screenSnapshotFrameRef.current) return;
    screenSnapshotFrameRef.current = requestAnimationFrame(() => {
      screenSnapshotFrameRef.current = null;
      emitScreenSnapshot();
    });
  }, [emitScreenSnapshot]);

  useEffect(() => () => {
    if (screenSnapshotFrameRef.current && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(screenSnapshotFrameRef.current);
      screenSnapshotFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    usesTmuxRef.current = Boolean(usesTmux);
  }, [usesTmux]);

  useEffect(() => {
    syncPtySizeRef.current = syncPtySize !== false;
  }, [syncPtySize]);

  useEffect(() => {
    webglEnabledRef.current = platformConfig.webglEnabled;
  }, [platformConfig.webglEnabled]);

  useEffect(() => {
    applyHistoryConfig();
    trimHistoryEntries();
  }, [applyHistoryConfig, trimHistoryEntries]);

  useEffect(() => {
    scrollModeRef.current = isScrollMode;
  }, [isScrollMode]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === 'reader') {
      setReaderScrollToken(Date.now());
      syncReaderBuffer();
    }
  }, [viewMode, syncReaderBuffer]);

  useEffect(() => {
    isPrimaryRef.current = Boolean(isPrimary);
  }, [isPrimary]);

  useEffect(() => {
    return () => {
      if (readerSyncRef.current) {
        cancelAnimationFrame(readerSyncRef.current);
        readerSyncRef.current = null;
      }
    };
  }, []);

  const refreshTerminalViewport = useCallback(({ fit = false, preserveBottom = false, clearAtlas = false } = {}) => {
    const term = xtermRef.current;
    if (!term) return;

    const container = terminalRef.current;
    const canRender = (() => {
      if (!container) return false;
      if (container.getClientRects().length === 0) return false;
      const { width, height } = container.getBoundingClientRect();
      if (width < MIN_FIT_CONTAINER_WIDTH || height < MIN_FIT_CONTAINER_HEIGHT) return false;
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const computed = window.getComputedStyle(container);
        if (computed.display === 'none' || computed.visibility === 'hidden') return false;
      }
      return true;
    })();

    // Block fit() while history is being loaded: the stored ANSI sequences were
    // recorded at the PTY's original width. Resizing xterm mid-playback misaligns
    // cursor positions and causes severe content garbling. fit() will be triggered
    // explicitly once loadInitialHistory() completes.
    let handledByAuthoritativeResize = false;
    if (fit && canRender && !historyReloadingRef.current && requestAuthoritativeResizeRef.current) {
      try {
        handledByAuthoritativeResize = requestAuthoritativeResizeRef.current() === true;
      } catch {
        handledByAuthoritativeResize = false;
      }
    }

    if (fit && fitAddonRef.current && canRender && !historyReloadingRef.current && !handledByAuthoritativeResize) {
      let wasAtBottom = true;
      if (preserveBottom) {
        const buffer = term.buffer?.active;
        wasAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
      }
      fitAddonRef.current.fit();
      if (preserveBottom && wasAtBottom) {
        term.scrollToBottom();
      }
    }

    if (clearAtlas && webglAddonRef.current?.clearTextureAtlas) {
      try {
        webglAddonRef.current.clearTextureAtlas();
      } catch {
        // Ignore WebGL atlas refresh failures and keep canvas fallback behavior.
      }
    }

    if (canRender) {
      try {
        const rows = term.rows || 0;
        if (rows > 0) {
          term.refresh(0, rows - 1);
        }
      } catch {
        // Ignore transient refresh failures during rapid mount/unmount.
      }
    }
  }, [MIN_FIT_CONTAINER_HEIGHT, MIN_FIT_CONTAINER_WIDTH]);

  const scheduleViewportRefresh = useCallback(({
    delay,
    immediate = false,
    fit = true,
    preserveBottom = true,
    clearAtlas = false
  } = {}) => {
    const resolvedDelay = delay ?? (isMobile ? 60 : 120);
    const previous = pendingFitOptionsRef.current || { fit: false, preserveBottom: false, clearAtlas: false };
    pendingFitOptionsRef.current = {
      fit: previous.fit || fit,
      preserveBottom: previous.preserveBottom || preserveBottom,
      clearAtlas: previous.clearAtlas || clearAtlas
    };

    const flushPendingRefresh = () => {
      fitTimeoutRef.current = null;
      if (fitRafRef.current) cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        const options = pendingFitOptionsRef.current;
        pendingFitOptionsRef.current = null;
        if (!options) return;
        refreshTerminalViewport(options);
      });
    };

    if (fitTimeoutRef.current) {
      clearTimeout(fitTimeoutRef.current);
      fitTimeoutRef.current = null;
    }

    if (immediate || resolvedDelay <= 0) {
      flushPendingRefresh();
      return;
    }

    fitTimeoutRef.current = setTimeout(flushPendingRefresh, resolvedDelay);
  }, [isMobile, refreshTerminalViewport]);

  useEffect(() => {
    if (viewMode !== 'terminal') return;
    scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true, clearAtlas: true });
  }, [viewMode, scheduleViewportRefresh]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    restoreSessionRef.current = restoreSession;
  }, [restoreSession]);

  useEffect(() => {
    updateSessionTopicRef.current = updateSessionTopic;
  }, [updateSessionTopic]);

  useEffect(() => {
    previewInputLineRef.current = '';
    idlePromptProbeRef.current = '';
  }, [sessionId]);

  // Reset loading state when session changes
  useEffect(() => {
    shouldReplayHistoryRef.current = !skipHistory;
    restoreRetryAttemptedRef.current = false;
    restoreAttempt2Ref.current = false;
    setIsLoadingMoreHistory(false);
    applyHistoryConfig();
    historyStateRef.current.exhausted = false;
    historyStateRef.current.loading = false;
    historyStateRef.current.lastCount = 0;
    historyStateRef.current.lastChars = 0;
    historyStateRef.current.lastLoadAt = 0;
    historyStateRef.current.oldestTs = null;
    historyStateRef.current.newestTs = null;
    historyStateRef.current.oldestSeq = null;
    historyStateRef.current.newestSeq = null;
    ptyOwnerStateRef.current = {
      isOwner: null,
      ownerClientId: null,
      appliedCols: null,
      appliedRows: null
    };
    setPtyOwnerState(ptyOwnerStateRef.current);
    resetHistoryCache();
    historyReloadingRef.current = false;
    pendingSocketDataRef.current = [];
    resetCopyModeState();
  }, [applyHistoryConfig, resetCopyModeState, resetHistoryCache, sessionId, skipHistory]);

  // Register image upload trigger for external components
  useEffect(() => {
    if (onRegisterImageUpload) {
      onRegisterImageUpload(triggerFileInput);
    }
  }, [onRegisterImageUpload, triggerFileInput]);

  // Register history panel trigger for external components
  useEffect(() => {
    if (onRegisterHistoryPanel) {
      onRegisterHistoryPanel(() => setHistoryModalOpen(true));
    }
  }, [onRegisterHistoryPanel]);

  // Register selection actions for mobile long-press context menu
  useEffect(() => {
    if (!onRegisterSelectionActions) return undefined;

    onRegisterSelectionActions({
      hasSelection: hasTerminalSelection,
      copySelection: copyTerminalSelection
    });

    return () => {
      onRegisterSelectionActions(null);
    };
  }, [onRegisterSelectionActions, hasTerminalSelection, copyTerminalSelection]);

  // Register focus terminal trigger for iOS keyboard activation
  useEffect(() => {
    if (onRegisterFocusTerminal) {
      onRegisterFocusTerminal(() => {
        prepareTerminalForExternalInput({
          requestPriorityResize: requestPriorityResizeRef.current,
          focusTerminal: () => xtermRef.current?.focus?.(),
          setMobileInputEnabled
        });
      });
    }
  }, [onRegisterFocusTerminal, setMobileInputEnabled]);

  // Register send-text function for external callers (e.g. chat input bar)
  useEffect(() => {
    if (!onRegisterSendText) return undefined;
    onRegisterSendText((text) => {
      if (!text) return false;
      prepareTerminalForExternalInput({
        requestPriorityResize: requestPriorityResizeRef.current,
        focusTerminal: () => xtermRef.current?.focus?.(),
        setMobileInputEnabled
      });
      const enqueueExternalInput = enqueueExternalInputRef.current;
      if (!enqueueExternalInput) {
        pendingExternalInputRef.current.push(text);
        return false;
      }
      return enqueueExternalInput(text);
    });
    return () => {
      onRegisterSendText(null);
    };
  }, [onRegisterSendText, setMobileInputEnabled]);

  const jumpToLatestOutput = useCallback(() => {
    if (viewModeRef.current === 'reader') {
      setReaderScrollToken((value) => value + 1);
      onViewportStateChangeRef.current?.(true);
      return;
    }

    jumpToLive();
    onViewportStateChangeRef.current?.(true);
  }, [jumpToLive]);

  // Register scroll-to-bottom function for external callers (e.g. floating button)
  useEffect(() => {
    if (onRegisterScrollToBottom) {
      onRegisterScrollToBottom(() => {
        jumpToLatestOutput();
      });
    }
  }, [jumpToLatestOutput, onRegisterScrollToBottom]);

  // Update document.title with active session name
  useEffect(() => {
    if (!isActiveSession) return;
    const session = sessions.find(s => s.id === sessionId);
    document.title = session?.title || 'Terminal';
  }, [isActiveSession, sessionId, sessions]);

  // Main terminal initialization effect
  useEffect(() => {
    if (!sessionId || !terminalRef.current) return;

    let disposed = false;
    let hasOpened = false;
    let rafId = null;
    let resizeObserver = null;
    let openRetryCount = 0;
    let openRetryTimeout = null;
    let iosRefreshRaf = null;
    const MAX_OPEN_RETRIES = 20;
    let suppressResizeSyncCount = 0;
    let pendingTrackedResize = null;
    let lastResizeRequestKey = '';

    const scrollback = performanceMode
      ? platformConfig.scrollback
      : platformConfig.scrollback * (isMobile ? 2 : 3);
    const defaultTerminalFontSize = platformConfig.fontSize;
    const terminalFontFamily = isMobile
      ? 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace'
      : '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';

    const term = new Terminal({
      cursorBlink: false,
      cols: 250,
      fontSize: defaultTerminalFontSize,
      fontFamily: terminalFontFamily,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback,
      theme: getTerminalTheme(theme),
      allowProposedApi: true,
      windowOptions: {
        setWinSizePixels: false, raiseWin: false, lowerWin: false, refreshWin: false,
        restoreWin: false, minimizeWin: false, setWinPosition: false, setWinSizeChars: false,
        fullscreenWin: false, maximizeWin: false, getWinState: false, getWinPosition: false,
        getWinSizePixels: false, getScreenSizePixels: false, getCellSizePixels: false,
        getWinSizeChars: false, getScreenSizeChars: false, getIconTitle: false,
        getWinTitle: false, pushTitle: false, popTitle: false, setWinLines: false
      }
    });

    const scheduleIOSRefresh = () => {
      if (!isMobile || !isIOS) return;
      if (iosRefreshRaf) return;
      iosRefreshRaf = requestAnimationFrame(() => {
        iosRefreshRaf = null;
        if (disposed || !xtermRef.current) return;
        try {
          const rows = xtermRef.current.rows || 0;
          if (rows > 0) {
            xtermRef.current.refresh(0, rows - 1);
          }
        } catch {
          // Ignore transient refresh failures during resize/reconnect.
        }
      });
    };

    const getBestTerminalDimensions = () => {
      const proposed = fitAddonRef.current?.proposeDimensions?.();
      const cols = proposed?.cols >= 20 ? proposed.cols : term.cols;
      const rows = proposed?.rows >= 3 ? proposed.rows : term.rows;
      return { cols, rows };
    };

    const withResizeSyncSuppressed = (fn) => {
      suppressResizeSyncCount += 1;
      try {
        fn();
      } finally {
        suppressResizeSyncCount = Math.max(0, suppressResizeSyncCount - 1);
      }
    };

    const applyServerPtySize = (cols, rows) => {
      const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(500, Math.round(cols))) : 0;
      const nextRows = Number.isFinite(rows) ? Math.max(3, Math.min(500, Math.round(rows))) : 0;
      if (!nextCols || !nextRows) return;
      if (term.cols === nextCols && term.rows === nextRows) return;
      withResizeSyncSuppressed(() => {
        try {
          term.resize(nextCols, nextRows);
        } catch {
          // Ignore transient resize failures during mount/reconnect.
        }
      });
    };

    const updatePtyOwnerFromResizeAck = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const next = {
        isOwner: typeof payload.isOwner === 'boolean' ? payload.isOwner : null,
        ownerClientId: typeof payload.ownerClientId === 'string' ? payload.ownerClientId : null,
        appliedCols: Number.isFinite(payload.appliedCols) ? Number(payload.appliedCols) : null,
        appliedRows: Number.isFinite(payload.appliedRows) ? Number(payload.appliedRows) : null
      };
      if (next.isOwner === true && next.appliedCols && next.appliedRows) {
        applyServerPtySize(next.appliedCols, next.appliedRows);
      }
      const prev = ptyOwnerStateRef.current;
      if (
        prev.isOwner === next.isOwner &&
        prev.ownerClientId === next.ownerClientId &&
        prev.appliedCols === next.appliedCols &&
        prev.appliedRows === next.appliedRows
      ) {
        return;
      }
      ptyOwnerStateRef.current = next;
      if (!disposed) {
        setPtyOwnerState(next);
      }
      if (pendingOwnerPromotionRef.current && next.isOwner === true) {
        pendingOwnerPromotionRef.current = false;
        ownerPromotionDeadlineRef.current = 0;
        if (ownerPromotionTimerRef.current) {
          clearTimeout(ownerPromotionTimerRef.current);
          ownerPromotionTimerRef.current = null;
        }
        if (!disposed) {
          flushInputBuffer();
        }
      }
    };

    const awaitOwnerPromotionBeforeInput = () => {
      pendingOwnerPromotionRef.current = true;
      ownerPromotionDeadlineRef.current = Date.now() + 250;
      if (ownerPromotionTimerRef.current) {
        clearTimeout(ownerPromotionTimerRef.current);
      }
      ownerPromotionTimerRef.current = setTimeout(() => {
        ownerPromotionTimerRef.current = null;
        pendingOwnerPromotionRef.current = false;
        ownerPromotionDeadlineRef.current = 0;
        if (!disposed) {
          flushInputBuffer();
        }
      }, 250);
    };

    const postTrackedResize = ({ cols, rows, clientId, priority = false }) => {
      if (!syncPtySizeRef.current || disposed) return;
      const nextCols = Number.isFinite(cols) ? Math.max(20, Math.min(500, Math.round(cols))) : 0;
      const nextRows = Number.isFinite(rows) ? Math.max(3, Math.min(500, Math.round(rows))) : 0;
      if (!nextCols || !nextRows) return;

      if (!clientId) {
        // Wait for the WS-assigned clientId so the backend can attribute ownership.
        pendingTrackedResize = { cols: nextCols, rows: nextRows, priority: Boolean(priority) };
        return;
      }

      const requestKey = `${clientId}:${nextCols}x${nextRows}:${priority ? '1' : '0'}`;
      if (requestKey === lastResizeRequestKey) return;
      lastResizeRequestKey = requestKey;

      const body = priority
        ? { cols: nextCols, rows: nextRows, clientId, priority: true }
        : { cols: nextCols, rows: nextRows, clientId };

      apiFetch(`/api/terminal/${sessionId}/resize`, {
        method: 'POST',
        body
      })
        .then(async (response) => {
          if (!response?.ok) return;
          const payload = await response.json().catch(() => null);
          updatePtyOwnerFromResizeAck(payload);
        })
        .catch((error) => {
          if (lastResizeRequestKey === requestKey) {
            lastResizeRequestKey = '';
          }
          console.error('Failed to send resize:', error);
        });
    };

    const flushPendingTrackedResize = (clientId) => {
      if (!clientId || !pendingTrackedResize) return false;
      const pending = pendingTrackedResize;
      pendingTrackedResize = null;
      postTrackedResize({ ...pending, clientId });
      return true;
    };

    const syncPtySize = ({ clientId, dims, priorityOverride } = {}) => {
      if (!syncPtySizeRef.current) return;
      const { cols, rows } = dims || getBestTerminalDimensions();
      if (!cols || !rows) return;
      const priority = typeof priorityOverride === 'boolean'
        ? priorityOverride
        : (isPrimaryRef.current && !isMobile);
      postTrackedResize({
        cols,
        rows,
        clientId,
        priority
      });
    };

    requestAuthoritativeResizeRef.current = () => {
      if (!syncPtySizeRef.current || disposed || historyReloadingRef.current) return false;
      const ownerState = ptyOwnerStateRef.current;
      const shouldDrivePtyResize = ownerState.isOwner !== false || (isPrimaryRef.current && !isMobile);
      if (!shouldDrivePtyResize) return false;
      const { cols, rows } = getBestTerminalDimensions();
      if (!cols || !rows) return false;
      if (term.cols === cols && term.rows === rows) return true;
      syncPtySize({ clientId: clientIdRef.current || undefined, dims: { cols, rows } });
      return true;
    };
    requestPriorityResizeRef.current = () => {
      if (!syncPtySizeRef.current || disposed || historyReloadingRef.current) return false;
      const clientId = clientIdRef.current;
      if (!clientId) return false;
      const ownerClientId = ptyOwnerStateRef.current.ownerClientId;
      if (ownerClientId && ownerClientId !== clientId) {
        awaitOwnerPromotionBeforeInput();
      }
      syncPtySize({ clientId, priorityOverride: true });
      return true;
    };

    const writeTerminal = (text, callback) => {
      if (typeof callback === 'function') {
        term.write(text, () => {
          callback();
          scheduleIOSRefresh();
          scheduleScreenSnapshot();
        });
        return;
      }
      term.write(text);
      scheduleIOSRefresh();
      scheduleScreenSnapshot();
    };

    const capturePreviewFromInput = (text) => {
      if (!sessionId || !text) return;
      const completedLines = extractCompletedLinesFromTerminalInputChunk(text, previewInputLineRef);
      if (completedLines.length === 0) return;

      const sessionSnapshot = sessionsRef.current.find((session) => session.id === sessionId);
      if (!sessionSnapshot) return;

      // Respect manually-set topics; only auto-update auto-generated/empty topics.
      if (sessionSnapshot.thread?.topic && sessionSnapshot.thread?.topicAutoGenerated === false) {
        return;
      }

      let candidate = null;
      for (const line of completedLines) {
        const next = toPreviewCandidate(line);
        if (next) candidate = next;
      }
      if (!candidate) return;
      if (sessionSnapshot.thread?.topic === candidate) return;

      const last = lastAutoPreviewRef.current;
      if (last.sessionId === sessionId && last.value === candidate) return;
      lastAutoPreviewRef.current = { sessionId, value: candidate };

      void updateSessionTopicRef.current?.(sessionId, candidate, true).catch(() => {
        const currentLast = lastAutoPreviewRef.current;
        if (currentLast.sessionId === sessionId && currentLast.value === candidate) {
          lastAutoPreviewRef.current = { sessionId: null, value: '' };
        }
      });
    };

    const sendTerminalInput = (text) => {
      if (!text || disposed) return;
      const resolvedText = rewriteTerminalAgentInput(text);
      capturePreviewFromInput(resolvedText);
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(resolvedText);
        onSendMessageRef.current?.(resolvedText);
        return;
      }
      onSendMessageRef.current?.(resolvedText);
      apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: resolvedText }
      }).catch((error) => {
        console.error('Failed to send terminal input:', error);
      });
    };

    const flushInputBuffer = () => {
      if (disposed) return;
      if (inputFlushRef.current) {
        clearTimeout(inputFlushRef.current);
        inputFlushRef.current = null;
      }
      if (!inputBufferRef.current) return;
      if (pendingOwnerPromotionRef.current) {
        if (ptyOwnerStateRef.current.isOwner === true || Date.now() >= ownerPromotionDeadlineRef.current) {
          pendingOwnerPromotionRef.current = false;
          ownerPromotionDeadlineRef.current = 0;
          if (ownerPromotionTimerRef.current) {
            clearTimeout(ownerPromotionTimerRef.current);
            ownerPromotionTimerRef.current = null;
          }
        } else {
          inputFlushRef.current = setTimeout(flushInputBuffer, 10);
          return;
        }
      }
      const payload = inputBufferRef.current;
      inputBufferRef.current = '';
      sendTerminalInput(payload);
    };

    const queueTerminalInput = (data) => {
      if (!data || disposed) return;
      inputBufferRef.current += data;
      if (!inputFlushRef.current) {
        inputFlushRef.current = setTimeout(flushInputBuffer, 0);
      }
      if (data.includes('\r')) {
        flushInputBuffer();
      }
    };

    const sendUserInput = (text) => {
      if (!text || disposed) return;
      exitCopyModeIfActive();
      markUserInput();
      resetIdleTimer(false);
      if (inputBufferRef.current) {
        flushInputBuffer();
      }
      sendTerminalInput(text);
    };
    const clearExternalInputTimer = () => {
      if (externalInputTimerRef.current) {
        clearTimeout(externalInputTimerRef.current);
        externalInputTimerRef.current = null;
      }
    };
    const scheduleExternalInputDrain = () => {
      if (disposed || externalInputFramesRef.current.length === 0 || externalInputTimerRef.current) {
        return;
      }
      const delay = Math.max(0, nextExternalInputAtRef.current - Date.now());
      externalInputTimerRef.current = setTimeout(() => {
        externalInputTimerRef.current = null;
        drainExternalInput();
      }, delay);
    };
    const drainExternalInput = () => {
      if (disposed || externalInputFramesRef.current.length === 0) return;
      if (Date.now() < nextExternalInputAtRef.current) {
        scheduleExternalInputDrain();
        return;
      }
      const nextFrame = externalInputFramesRef.current.shift();
      if (!nextFrame?.data) return;
      sendUserInput(nextFrame.data);
      nextExternalInputAtRef.current = Date.now() + (Number.isFinite(nextFrame.delayAfterMs) ? nextFrame.delayAfterMs : 0);
      if (externalInputFramesRef.current.length > 0) {
        scheduleExternalInputDrain();
      }
    };
    const enqueueExternalInput = (text) => {
      const frames = createExternalInputFrames(text);
      if (disposed || frames.length === 0) return false;
      externalInputFramesRef.current.push(...frames);
      scheduleExternalInputDrain();
      drainExternalInput();
      return true;
    };
    const confirmLargePaste = (text) => {
      if (!text) return false;
      if (text.length <= LARGE_PASTE_THRESHOLD) return true;
      return window.confirm(`Paste ${text.length} characters into the terminal?`);
    };
    const sendPastedText = (text) => {
      if (!text || disposed) return;
      if (!confirmLargePaste(text)) return;
      sendUserInput(`\x1b[200~${text}\x1b[201~`);
    };
    const shouldSendTextBeforeImage = (text) => {
      if (!hasMeaningfulClipboardText(text)) return false;
      return !shouldPreferImageOverText(text);
    };
    sendTerminalInputRef.current = sendUserInput;
    enqueueExternalInputRef.current = enqueueExternalInput;
    if (pendingExternalInputRef.current.length > 0) {
      const queuedInputs = pendingExternalInputRef.current.splice(0, pendingExternalInputRef.current.length);
      for (const queuedText of queuedInputs) {
        enqueueExternalInput(queuedText);
      }
    }
    if (registerTerminalSender) {
      registerTerminalSender(sessionId, sendUserInput);
    }

    const handleClipboardPaste = async () => {
      try {
        let clipboardText = '';
        if (navigator.clipboard?.readText) {
          try {
            clipboardText = await navigator.clipboard.readText();
            if (shouldSendTextBeforeImage(clipboardText)) {
              sendPastedText(clipboardText);
              return;
            }
          } catch {
            // Continue to image handling
          }
        }

        if (navigator.clipboard?.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();
            const imageFile = await getImageFileFromClipboardItems(clipboardItems);
            if (imageFile) {
              const path = await uploadScreenshot(imageFile);
              if (path) {
                sendPastedText(path + ' ');
                return;
              }
            }
          } catch {
            // Ignore and fall back to text below
          }
        }

        if (navigator.clipboard?.readText) {
          if (!hasMeaningfulClipboardText(clipboardText)) {
            clipboardText = await navigator.clipboard.readText();
          }
          if (hasMeaningfulClipboardText(clipboardText)) {
            sendPastedText(clipboardText);
          }
        }
      } catch (err) {
        console.error('Failed to read clipboard:', err);
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      // Allow native copy when text is selected
      if (event.ctrlKey && event.key === 'c' && term.hasSelection()) {
        return false;
      }

      // Allow native paste event to fire (handled by paste event listener below)
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        return false;
      }

      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const openWhenReady = () => {
      if (disposed || hasOpened) return;
      const container = terminalRef.current;
      if (!container) return;

      const { width, height } = container.getBoundingClientRect();
      const containerTooSmall = width < MIN_FIT_CONTAINER_WIDTH || height < MIN_FIT_CONTAINER_HEIGHT;
      if (containerTooSmall) {
        if (openRetryCount < MAX_OPEN_RETRIES) {
          openRetryCount++;
          const retryDelay = openRetryCount < 30 ? 0 : 150;
          if (openRetryTimeout) clearTimeout(openRetryTimeout);
          if (retryDelay === 0) {
            rafId = requestAnimationFrame(openWhenReady);
          } else {
            openRetryTimeout = setTimeout(() => {
              if (!disposed) {
                rafId = requestAnimationFrame(openWhenReady);
              }
            }, retryDelay);
          }
          return;
        }
        if (openRetryCount === MAX_OPEN_RETRIES) {
          console.warn(
            '[Terminal] Container never reached viable size; forcing init so transport can connect',
            { width, height, retries: MAX_OPEN_RETRIES }
          );
          openRetryCount++;
        }
      }

      hasOpened = true;
      term.open(container);

      // Pre-block fit() until loadInitialHistory() finishes.
      // xterm is initialised at cols=250 so that ANSI cursor-positioning sequences
      // in the stored history (which may have been recorded at any PTY width up to
      // 250) execute at their original column without being clamped. If fit() ran
      // before history finished it would resize xterm to the (narrower) container
      // width, clamping those positions and garbling the historical content.
      // loadInitialHistory() clears this flag and schedules a fit() once playback
      // is safe. The existing historyReloadingRef guard in refreshTerminalViewport
      // ensures no fit() slips through between here and WS connect.
      historyReloadingRef.current = true;

      const requestPostOpenFit = () => {
        if (disposed || !xtermRef.current) return;
        scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true, clearAtlas: true });
      };

      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready.then(() => {
          if (!disposed) {
            requestPostOpenFit();
          }
        }).catch(() => {});
      }
      setTimeout(() => {
        if (!disposed) {
          requestPostOpenFit();
        }
      }, 200);

      const initWebglAddon = () => {
        const shouldEnableWebgl = platformConfig.webglEnabled;
        if (!shouldEnableWebgl || webglAddonRef.current) {
          return;
        }
        try {
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            console.warn('[WebGL] Context lost, falling back to canvas renderer');
            try {
              webglAddon.dispose();
            } catch {}
            if (webglAddonRef.current === webglAddon) {
              webglAddonRef.current = null;
            }
            scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true });
          });
          term.loadAddon(webglAddon);
          webglAddonRef.current = webglAddon;

          // Verify WebGL renderer is active
          setTimeout(() => {
            const renderer = term._core?._renderService?._renderer;
            const rendererName = renderer?.constructor?.name;
            if (rendererName === 'WebglRenderer') {
              console.log('[WebGL] GPU acceleration active');
            } else {
              console.warn('[WebGL] Fallback to canvas renderer:', rendererName);
            }
          }, 100);
        } catch (error) {
          console.warn('[WebGL] Failed to initialize, using canvas fallback:', error);
        }
      };
      initWebglAddon();

      const textarea = term.textarea;
      let isComposing = false;
      const handleCompositionStart = () => { isComposing = true; };
      const handleCompositionEnd = () => { isComposing = false; };
      term._isComposing = () => isComposing;

      if (textarea) {
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        textarea.addEventListener('compositionstart', handleCompositionStart);
        textarea.addEventListener('compositionend', handleCompositionEnd);
        if (isMobile) {
          textarea.readOnly = true;
          textarea.inputMode = 'none';
        }
      }

      // Custom wheel handling: let xterm handle scrolling natively for smooth
      // scroll, only intercept when xterm scrollback is exhausted (tmux copy-mode)
      // On mobile, never intercept — let native touch scroll handle everything.
      term.attachCustomWheelEventHandler((event) => {
        if (isMobile) {
          // On mobile, always let xterm handle scroll natively
          if (event.deltaY < 0) {
            setTimeout(() => triggerLoadMoreIfAtTop(), 0);
          }
          return true;
        }

        if (!usesTmuxRef.current) {
          return true;
        }

        const buffer = term.buffer?.active;
        const isAlternate = buffer?.type === 'alternate';
        const mouseTrackingMode = term.modes?.mouseTrackingMode;

        if (mouseTrackingMode && mouseTrackingMode !== 'none' && isAlternate) {
          return true;
        }

        if (event.deltaY === 0) {
          return true;
        }

        // If currently in tmux copy-mode, keep handling through tmux
        if (inCopyModeRef.current) {
          event.preventDefault();
          scrollByWheel(event.deltaY, event.deltaMode, term.rows);
          return false;
        }

        const baseY = buffer?.baseY || 0;

        // xterm has scrollback — let it handle natively (smooth scroll)
        if (baseY > 0) {
          if (event.deltaY < 0) {
            setTimeout(() => triggerLoadMoreIfAtTop(), 0);
          }
          return true;
        }

        // baseY === 0 and scrolling UP: xterm scrollback exhausted → tmux copy-mode
        if (event.deltaY < 0) {
          event.preventDefault();
          scrollByWheel(event.deltaY, event.deltaMode, term.rows);
          triggerLoadMoreIfAtTop();
          return false;
        }

        // baseY === 0 and scrolling DOWN: nothing to scroll
        return true;
      });

      // Scroll direction detection for header collapse
      let lastScrollPos = 0;
      let scrollThrottleTimer = null;
      const fetchHistoryPage = async ({ beforeTs, afterTs, beforeSeq, afterSeq, mode = 'page' } = {}) => {
        const state = historyStateRef.current;
        const historyEvents = mode === 'initial'
          ? platformConfig.history.initialEvents
          : state.pageEvents;
        const historyChars = mode === 'initial'
          ? platformConfig.history.initialChars
          : state.pageChars;
        const params = new URLSearchParams();
        params.set('historyEvents', String(historyEvents));
        params.set('historyChars', String(historyChars));
        if (Number.isFinite(beforeSeq) && beforeSeq > 0) {
          params.set('beforeSeq', String(beforeSeq));
        }
        if (Number.isFinite(afterSeq) && afterSeq >= 0) {
          params.set('afterSeq', String(afterSeq));
        }
        if (beforeTs) {
          params.set('beforeTs', String(beforeTs));
        }
        if (afterTs) {
          params.set('afterTs', String(afterTs));
        }
        const response = await apiFetch(`/api/terminal/${sessionId}/history?${params.toString()}`);
        if (!response.ok) return null;
        const snapshot = await response.json();
        return {
          history: Array.isArray(snapshot?.history) ? snapshot.history : [],
          currentCols: Number.isFinite(snapshot?.currentCols) ? snapshot.currentCols : null,
          currentRows: Number.isFinite(snapshot?.currentRows) ? snapshot.currentRows : null,
          nextSeq: Number.isFinite(snapshot?.nextSeq) ? Number(snapshot.nextSeq) : null
        };
      };

      const writeHistoryChunks = (historyText) => new Promise((resolve) => {
        if (!historyText) {
          resolve();
          return;
        }
        const chunkSize = platformConfig.history.writeChunkChars;
        let offset = 0;
        const writeNext = () => {
          if (disposed) {
            resolve();
            return;
          }
          const chunk = historyText.slice(offset, offset + chunkSize);
          offset += chunk.length;
          writeTerminal(chunk, () => {
            if (offset < historyText.length) {
              setTimeout(writeNext, 0);
            } else {
              resolve();
            }
          });
        };
        writeNext();
      });

      const flushPendingSocketData = () => {
        if (disposed) return;
        const pending = pendingSocketDataRef.current;
        pendingSocketDataRef.current = [];
        if (pending.length === 0) return;
        const pendingChunks = pending
          .map((item) => (typeof item === 'string' ? { text: item } : item))
          .filter((item) => item && typeof item.text === 'string' && item.text.length > 0);
        if (pendingChunks.length === 0) return;
        const pendingText = pendingChunks.map((item) => item.text).join('');
        reflectIdlePromptState(pendingText);
        onOutputChunkRef.current?.(pendingText);
        const shouldAppendReader = viewModeRef.current === 'reader' || !isMobile;
        if (viewModeRef.current === 'reader') {
          writeTerminal(pendingText, scheduleReaderSync);
        } else {
          writeTerminal(pendingText);
          if (shouldAppendReader) {
            appendToReader(pendingText);
          }
        }
        // Batch-append all pending chunks: push all entries then trim once,
        // instead of calling appendHistoryEntry (which trims after every chunk).
        const now = Date.now();
        let newestSeq = historyStateRef.current.newestSeq ?? 0;
        for (const item of pendingChunks) {
          const chunk = item.text;
          const seq = Number(item.seq);
          historyEntriesRef.current.push({
            text: chunk,
            ts: now,
            seq: Number.isFinite(seq) && seq > 0 ? seq : undefined
          });
          historyCharCountRef.current += chunk.length;
          historyTextRef.current += chunk;
          if (Number.isFinite(seq) && seq > 0) {
            newestSeq = Math.max(newestSeq, seq);
          }
        }
        if (pendingChunks.length > 0) {
          historyStateRef.current.newestTs = now;
          if (newestSeq > 0) {
            historyStateRef.current.newestSeq = newestSeq;
            lastServerSeqRef.current = Math.max(lastServerSeqRef.current, newestSeq);
          }
          trimHistoryEntries();
        }
      };

      const loadInitialHistory = async () => {
        if (disposed) return;
        const state = historyStateRef.current;
        if (state.loading) return;
        state.loading = true;
        state.lastLoadAt = Date.now();
        historyReloadingRef.current = true;
        setIsLoadingHistory(true);

        try {
          const historyPage = await fetchHistoryPage({ mode: 'initial' });
          if (!historyPage) {
            setIsLoadingHistory(false);
            return;
          }
          const history = historyPage.history;
          setHistoryEntries(history);
          state.exhausted = history.length === 0;
          term.reset();
          applyServerPtySize(historyPage.currentCols, historyPage.currentRows);
          clearReader();
          const historyText = historyTextRef.current;
          if (historyText) {
            reflectIdlePromptState(historyText);
            onOutputChunkRef.current?.(historyText);
          }
          await writeHistoryChunks(historyText);
          if (disposed) return;
          if (viewModeRef.current === 'reader') {
            syncReaderBuffer();
          } else if (!isMobile) {
            appendToReader(historyText);
          }
          historyReloadingRef.current = false;
          flushPendingSocketData();
          setIsLoadingHistory(false);
          shouldReplayHistoryRef.current = false;
          // Now that history is fully written (at the PTY's original width), it is safe
          // to fit xterm to the actual container size. This may soft-wrap historical
          // content but keeps the cursor positions correct — avoids mid-playback garbling.
          scheduleViewportRefresh({ delay: 50, fit: true, preserveBottom: false, clearAtlas: true });
          setTimeout(() => {
            if (disposed) return;
            syncPtySize({ clientId: clientIdRef.current || undefined });
          }, 180);
        } catch {
          // Ignore load failures; retry on next reconnect.
        } finally {
          state.loading = false;
          if (historyReloadingRef.current) {
            historyReloadingRef.current = false;
            flushPendingSocketData();
            setIsLoadingHistory(false);
            scheduleViewportRefresh({ delay: 50, fit: true, preserveBottom: false, clearAtlas: true });
            setTimeout(() => {
              if (disposed) return;
              syncPtySize({ clientId: clientIdRef.current || undefined });
            }, 180);
          }
        }
      };

      const loadMoreHistory = async () => {
        if (disposed) return;
        const state = historyStateRef.current;
        if (state.loading || state.exhausted || (!state.oldestTs && !state.oldestSeq)) return;
        const now = Date.now();
        if (now - state.lastLoadAt < 1500) return;

        state.loading = true;
        state.lastLoadAt = now;
        historyReloadingRef.current = true;
        setIsLoadingMoreHistory(true);

        try {
          const previousOldestTs = state.oldestTs;
          const previousOldestSeq = state.oldestSeq;
          const historyPage = await fetchHistoryPage(
            state.oldestSeq
              ? { beforeSeq: state.oldestSeq }
              : { beforeTs: state.oldestTs }
          );
          const history = historyPage?.history || null;
          if (!history || history.length === 0) {
            state.exhausted = true;
            return;
          }
          prependHistoryEntries(history);
          if (
            (previousOldestSeq && state.oldestSeq === previousOldestSeq) ||
            (!previousOldestSeq && state.oldestTs === previousOldestTs)
          ) {
            state.exhausted = true;
          }

          const historyText = historyTextRef.current;
          term.reset();
          clearReader();
          if (historyText) {
            reflectIdlePromptState(historyText);
            onOutputChunkRef.current?.(historyText);
          }
          await writeHistoryChunks(historyText);
          if (disposed) return;
          if (viewModeRef.current === 'reader') {
            syncReaderBuffer();
          } else if (!isMobile) {
            appendToReader(historyText);
          }
          term.scrollToTop();
          historyReloadingRef.current = false;
          flushPendingSocketData();
        } catch {
          // Ignore load failures; retry on next scroll-to-top.
        } finally {
          state.loading = false;
          if (historyReloadingRef.current) {
            historyReloadingRef.current = false;
            flushPendingSocketData();
          }
          setIsLoadingMoreHistory(false);
        }
      };
      loadMoreHistoryRef.current = loadMoreHistory;

      const loadIncrementalHistory = async () => {
        if (disposed) return;
        const state = historyStateRef.current;
        if (state.loading || (!state.newestTs && !state.newestSeq)) return;
        state.loading = true;
        state.lastLoadAt = Date.now();
        historyReloadingRef.current = true;
        setIsLoadingHistory(true);

        try {
          const historyPage = await fetchHistoryPage(
            state.newestSeq !== null && state.newestSeq !== undefined
              ? { afterSeq: state.newestSeq }
              : { afterTs: state.newestTs }
          );
          const history = historyPage?.history || null;
          if (!history || history.length === 0) return;
            history.forEach((entry) => appendHistoryEntry(entry));
            const combined = history.map((entry) => entry.text || '').join('');
            if (combined) {
              reflectIdlePromptState(combined);
              onOutputChunkRef.current?.(combined);
              const buffer = term.buffer?.active;
            const baseY = buffer?.baseY || 0;
            const viewportYBefore = buffer?.viewportY ?? 0;
            const wasAtBottom = buffer ? baseY === buffer.viewportY : true;

            if (viewModeRef.current === 'reader') {
              writeTerminal(combined, scheduleReaderSync);
            } else {
              writeTerminal(combined);
              if (!isMobile) {
                appendToReader(combined);
              }
            }

            if (!wasAtBottom) {
              const newBuffer = term.buffer?.active;
              const viewportYAfter = newBuffer?.viewportY ?? 0;
              const delta = viewportYBefore - viewportYAfter;
              if (delta !== 0) term.scrollLines(delta);
            }
          }
          historyReloadingRef.current = false;
          flushPendingSocketData();
          setIsLoadingHistory(false);
        } catch {
          // Ignore load failures; retry on next reconnect.
        } finally {
          state.loading = false;
          if (historyReloadingRef.current) {
            historyReloadingRef.current = false;
            flushPendingSocketData();
            setIsLoadingHistory(false);
          }
        }
      };
      let incrementalResyncTimer = null;
      let lastIncrementalResyncAt = 0;
      const scheduleIncrementalResync = (delay = 150) => {
        if (disposed) return;
        const now = Date.now();
        if (now - lastIncrementalResyncAt < 1000) return;
        if (incrementalResyncTimer) return;
        incrementalResyncTimer = setTimeout(() => {
          incrementalResyncTimer = null;
          if (disposed) return;
          lastIncrementalResyncAt = Date.now();
          void loadIncrementalHistory();
        }, delay);
      };
      let fullHistoryResyncTimer = null;
      let lastFullHistoryResyncAt = 0;
      const scheduleFullHistoryResync = (delay = 150) => {
        if (disposed) return;
        const now = Date.now();
        if (now - lastFullHistoryResyncAt < 1500) return;
        if (fullHistoryResyncTimer) return;
        fullHistoryResyncTimer = setTimeout(() => {
          fullHistoryResyncTimer = null;
          if (disposed) return;
          lastFullHistoryResyncAt = Date.now();
          void loadInitialHistory();
        }, delay);
      };
      const scheduleParserRecoveryResync = (delay = 150) => {
        // Incremental replay works for line-oriented output, but after a parser reset
        // it cannot reliably reconstruct TUI screen state (e.g. Claude Code) on slower
        // mobile devices. Rebuild from recent history instead.
        if (isMobile) {
          scheduleFullHistoryResync(delay);
          return;
        }
        scheduleIncrementalResync(delay);
      };
      const scrollDisposer = term.onScroll((newPos) => {
        const baseY = term.buffer?.active?.baseY ?? 0;
        onViewportStateChangeRef.current?.(newPos >= baseY);
        if (onScrollDirectionRef.current && !disposed) {
          const isUserScrolling = touchStateRef.current !== null;
          if (!isUserScrolling) {
            lastScrollPos = newPos;
            return;
          }
          const direction = newPos > lastScrollPos ? 'down' : 'up';
          if (!scrollThrottleTimer) {
            onScrollDirectionRef.current(direction);
            scrollThrottleTimer = setTimeout(() => { scrollThrottleTimer = null; }, 100);
          }
        }
        const reachedTopFromAbove = newPos === 0 && lastScrollPos > 0;
        if (reachedTopFromAbove) {
          loadMoreHistory();
        }
        lastScrollPos = newPos;
      });

      rafId = requestAnimationFrame(() => {
        if (!disposed && fitAddonRef.current) {
          scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true });
          // proposeDimensions() reads the container's actual pixel size and returns the
          // col/row count that fit() would use, without modifying the terminal. This lets
          // us send the correct PTY size *before* the nested-RAF fit actually runs.
          // Cols and rows are checked independently: a hidden/zero-height container
          // (e.g. the mobile terminal sheet before it opens) has the correct width
          // (left:0; right:0) but zero height — we still want to send the correct col count.
          syncPtySize({ clientId: clientIdRef.current || undefined });
        }
      });

      const debouncedFit = (delay = 120) => {
        if (disposed) return;
        scheduleViewportRefresh({ delay, fit: true, preserveBottom: true });
      };

      resizeObserver = new ResizeObserver(() => debouncedFit());
      resizeObserver.observe(container);

      const handleFocus = () => debouncedFit();
      const STALE_SOCKET_THRESHOLD = 25000;
      const isSocketDead = () => {
        const s = socketRef.current;
        return !s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING;
      };
      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          scheduleViewportRefresh({ delay: 80, fit: true, preserveBottom: true, clearAtlas: true });
          // Re-sync PTY size after fit completes in case it drifted while backgrounded.
          setTimeout(() => {
            if (disposed) return;
            syncPtySize({ clientId: clientIdRef.current || undefined });
          }, 300);
          const stale = socketRef.current?.readyState === WebSocket.OPEN
            && lastServerPingAtRef.current > 0
            && (Date.now() - lastServerPingAtRef.current) > STALE_SOCKET_THRESHOLD;
          if (navigator.onLine && (isSocketDead() || stale)) {
            if (stale) socketRef.current.close(4000, 'Stale on resume');
            reconnectSocketRef.current?.();
          } else {
            scheduleIncrementalResync(0);
          }
        }
      };
      const handleOnline = () => {
        pausedForOfflineRef.current = false;
        // Attempt reconnect only if socket is dead, not if still connecting
        if (isSocketDead()) {
          reconnectSocketRef.current?.();
        } else {
          scheduleIncrementalResync(0);
        }
      };
      const handleOffline = () => {
        pausedForOfflineRef.current = true;
      };
      window.addEventListener('focus', handleFocus);
      document.addEventListener('visibilitychange', handleVisibility);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      const buildSocketUrl = () => {
        const base = import.meta.env.VITE_API_URL || window.location.origin;
        const url = new URL(`/api/terminal/${sessionId}/ws`, base);
        url.searchParams.set('history', '0');
        if (USE_FRAMED_PROTOCOL) url.searchParams.set('framed', '1');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
      };

      const isAuthFailure = (error) => {
        const message = error instanceof Error ? error.message : '';
        return message === 'Token refresh failed' || message === 'No refresh token' || message === 'Invalid token response';
      };

      const ensureFreshSocketToken = async () => {
        const token = getAccessToken();
        if (!token) {
          return { ok: false, message: 'Session expired - please refresh' };
        }
        if (!isAccessTokenExpired(token, 30)) {
          return { ok: true };
        }
        try {
          let timeoutId = null;
          await Promise.race([
            refreshTokens(),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('Refresh timeout')), 5000);
            })
          ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
          });
          return { ok: true };
        } catch (error) {
          if (isAuthFailure(error)) {
            return { ok: false, message: 'Session expired - please refresh' };
          }
          return { ok: true };
        }
      };

      let wsRetryCount = 0;
      let authRetryCount = 0;
      let restoreRetryDelay = 5000;
      const MAX_WS_RETRY_DELAY = 30000;

      const connectSocket = () => {
        if (disposed) return () => {};
        // Skip reconnect if we're offline
        if (pausedForOfflineRef.current) return () => {};
        restoreRetryAttemptedRef.current = false;
        restoreAttempt2Ref.current = false;
        const existing = socketRef.current;
        if (existing) existing.close();
        // Store reconnect function for visibility/online handlers
        reconnectSocketRef.current = connectSocket;

        const shouldLoadHistory = shouldReplayHistoryRef.current;
        let socket = null;
        let hadConnectionError = false;
        let shouldReconnect = true;
        let skipUrlDetection = true;
        let skipUrlTimeout = null;
        let heartbeatTimer = null;
        let connectTimeout = null;
        lastServerPingAtRef.current = 0;
        const messageQueue = [];
        let processingQueue = false;
        let didOpen = false;
        let authConnected = false;
        const HEARTBEAT_INTERVAL = 10000;
        const HEARTBEAT_TIMEOUT = isMobile ? 30000 : 45000;
        const CONNECT_TIMEOUT = isMobile ? 20000 : 15000;

        const markDisconnected = () => {
          onConnectionChange?.(false);
          if (!didOpen) {
            setIsLoadingHistory(false);
          }
          if (historyReloadingRef.current) {
            historyReloadingRef.current = false;
            setIsLoadingHistory(false);
          }
        };

        const handleAuthFailure = (message) => {
          shouldReconnect = false;
          setIsLoadingHistory(false);
          onConnectionChange?.(false);
          if (!hadConnectionError) {
            hadConnectionError = true;
            writeTerminal(`\r\n[${message || 'Session expired - please refresh'}]\r\n`);
          }
        };

        const startSocket = async () => {
          const authResult = await ensureFreshSocketToken();
          if (disposed || !shouldReconnect) return;
          if (!authResult.ok) {
            handleAuthFailure(authResult.message);
            return;
          }

          socket = new WebSocket(buildSocketUrl());
          socket.binaryType = 'arraybuffer';
          socketRef.current = socket;
          if (connectTimeout) clearTimeout(connectTimeout);
          connectTimeout = setTimeout(() => {
            if (disposed || didOpen || !socket) return;
            markDisconnected();
            if (!hadConnectionError) {
              hadConnectionError = true;
              writeTerminal('\r\n[Connection timed out – retrying…]\r\n');
            }
            try {
              socket.close(4408, 'Connection timeout');
            } catch {}
          }, CONNECT_TIMEOUT);

          socket.onopen = () => {
            if (disposed) return;
            const token = getAccessToken();
            if (token) socket.send(JSON.stringify({ type: 'auth', token }));
            didOpen = true;
            if (connectTimeout) {
              clearTimeout(connectTimeout);
              connectTimeout = null;
            }
            wsRetryCount = 0;
            authRetryCount = 0;
            resetUserInput();
            // onConnectionChange(true) is deferred until the server confirms auth
            // by sending the clientId message — prevents premature input before auth
            lastServerPingAtRef.current = Date.now();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
              if (socket.readyState !== WebSocket.OPEN) return;
              // Initial/full history replay can take long enough on mobile devices to
              // delay processing of incoming ping frames. Treat that as local backpressure,
              // not a dead socket, otherwise we reconnect mid-replay and get stuck showing
              // "Loading history..." repeatedly.
              if (historyReloadingRef.current) {
                return;
              }
              const now = Date.now();
              if (now - lastServerPingAtRef.current > HEARTBEAT_TIMEOUT) {
                socket.close(4000, 'Heartbeat timeout');
              }
            }, HEARTBEAT_INTERVAL);
            if (hadConnectionError && shouldLoadHistory) {
              hadConnectionError = false;
              term.reset();
              clearReader();
            }
            skipUrlTimeout = setTimeout(() => {
              skipUrlDetection = false;
              if (!shouldLoadHistory) {
                setIsLoadingHistory(false);
              }
            }, 500);
            if (shouldLoadHistory) {
              if (shouldReplayHistoryRef.current) {
                void loadInitialHistory();
              } else {
                void loadIncrementalHistory();
              }
            } else {
              // Reconnect after silent disconnect — fetch any output missed during the gap.
              scheduleIncrementalResync(0);
            }
          };

          const socketDecoder = new TextDecoder();
          const decodeSocketData = async (payload) => {
            const decodeBuffer = (buffer) => {
              const view = new Uint8Array(buffer);
              if (view.length > 0 && (view[0] === 1 || view[0] === 2)) {
                const body = view.subarray(1);
                const text = socketDecoder.decode(body);
                if (view[0] === 2) {
                  return { type: 'meta', payload: text };
                }
                return { type: 'output', payload: text };
              }
              return { type: 'output', payload: socketDecoder.decode(view) };
            };

            if (payload instanceof ArrayBuffer) {
              return decodeBuffer(payload);
            }
            if (payload instanceof Blob) {
              const buffer = await payload.arrayBuffer();
              return decodeBuffer(buffer);
            }
            return { type: 'output', payload };
          };

          let pendingWrite = '';
          let pendingWriteLastSeq = null;
          let pendingWriteFrame = null;
          let parserRecoveryNeeded = false;
          const flushPendingWrites = () => {
            if (disposed) return;
            pendingWriteFrame = null;
            if (parserRecoveryNeeded) {
              parserRecoveryNeeded = false;
              pendingWrite = '';
              pendingWriteLastSeq = null;
              if (isMobile) {
                scheduleParserRecoveryResync(0);
                return;
              }
              term.reset();
              clearReader();
              const recoveryNotice = '\r\n[Terminal display resynced after high output]\r\n';
              writeTerminal(recoveryNotice);
              appendHistoryEntry({ text: recoveryNotice, ts: Date.now() });
              if (!isMobile) {
                appendToReader(recoveryNotice);
              }
            }
            if (!pendingWrite) return;

            const data = pendingWrite;
            pendingWrite = '';
            const pendingSeq = pendingWriteLastSeq;
            pendingWriteLastSeq = null;

            if (historyReloadingRef.current) {
              pendingSocketDataRef.current.push({ text: data, seq: pendingSeq ?? undefined });
              return;
            }

            const buffer = term.buffer?.active;
            const baseY = buffer?.baseY || 0;
            const viewportYBefore = buffer?.viewportY ?? 0;
            const wasAtBottom = buffer ? baseY === buffer.viewportY : true;

            appendHistoryEntry({
              text: data,
              ts: Date.now(),
              seq: Number.isFinite(pendingSeq) && pendingSeq > 0 ? pendingSeq : undefined
            });

            if (viewModeRef.current === 'reader') {
              writeTerminal(data, scheduleReaderSync);
            } else {
              writeTerminal(data);
              if (!isMobile) {
                appendToReader(data);
              }
            }

            if (!wasAtBottom) {
              const newBuffer = term.buffer?.active;
              const viewportYAfter = newBuffer?.viewportY ?? 0;
              const delta = viewportYBefore - viewportYAfter;
              if (delta !== 0) term.scrollLines(delta);
            }

            if (!skipUrlDetection) {
              resetIdleTimer(isScrollingRef.current);
            }

            if (!skipUrlDetection && onUrlDetected && isServerReady(data)) {
              const url = extractPreviewUrl(data);
              if (url && !detectedUrlsRef.current.has(url)) {
                detectedUrlsRef.current.add(url);
                onUrlDetected(url);
              }
            }

            if (tailModeRef.current) {
              const now = Date.now();
              if (now - lastDropNoticeAtRef.current > DROP_NOTICE_INTERVAL_MS) {
                const droppedChars = droppedOutputRef.current;
                const droppedEvents = droppedEventCountRef.current;
                droppedOutputRef.current = 0;
                droppedEventCountRef.current = 0;
                lastDropNoticeAtRef.current = now;
                tailModeRef.current = false;
                const parts = [];
                if (droppedChars > 0) parts.push(`${droppedChars} chars`);
                if (droppedEvents > 0) parts.push(`${droppedEvents} events`);
                const notice = `\r\n[Output skipped: ${parts.join(', ')} due to backlog]\r\n`;
                writeTerminal(notice);
                appendHistoryEntry({ text: notice, ts: Date.now() });
                if (!isMobile) {
                  appendToReader(notice);
                }
              }
            }
          };

          const enqueueTerminalWrite = (data, seq) => {
            if (!data) return;
            reflectIdlePromptState(data);
            onOutputChunkRef.current?.(data);
            pendingWrite += data;
            if (Number.isFinite(seq) && seq > 0) {
              pendingWriteLastSeq = Math.max(pendingWriteLastSeq || 0, Number(seq));
              lastServerSeqRef.current = Math.max(lastServerSeqRef.current, Number(seq));
            }
            if (pendingWrite.length > MAX_PENDING_WRITE_CHARS) {
              droppedOutputRef.current += pendingWrite.length;
              pendingWrite = '';
              pendingWriteLastSeq = null;
              parserRecoveryNeeded = true;
              tailModeRef.current = true;
              scheduleParserRecoveryResync(0);
            }
            if (pendingWriteFrame) return;
            pendingWriteFrame = requestAnimationFrame(flushPendingWrites);
          };

          const handleMetaMessage = (msg) => {
            if (!msg || typeof msg !== 'object') return false;
            if (msg.__terminal_meta) {
              msg = { ...msg, __terminal_meta: undefined };
            }

            const cliEvent = normalizeCliEventFromMeta(msg);
            if (cliEvent) {
              if (cliEventIndicatesTerminalIdle(cliEvent)) {
                onActivityChangeRef.current?.(false);
              }
              onCliEventRef.current?.(cliEvent);
              if (cliEvent.type === 'user_turn' || cliEvent.type === 'assistant_turn') {
                onTurn?.({
                  role: cliEvent.type === 'user_turn' ? 'user' : 'assistant',
                  content: cliEvent.content,
                  ts: cliEvent.ts ?? Date.now()
                });
              }
              return true;
            }

            if (msg.type === 'clientId' && msg.clientId && isValidClientId(msg.clientId)) {
              clientIdRef.current = msg.clientId;
              flushPendingTrackedResize(msg.clientId);
              syncPtySize({ clientId: msg.clientId });
              if (!authConnected) {
                authConnected = true;
                onConnectionChange?.(true);
              }
              return true;
            }
            if (msg.type === 'serverPing') {
              return true;
            }
            if (msg.type === 'serverCursor') {
              const seq = Number(msg.seq);
              if (Number.isFinite(seq) && seq > 0) {
                pendingServerSeqRef.current = seq;
                lastServerSeqRef.current = Math.max(lastServerSeqRef.current, seq);
              }
              return true;
            }
            if (msg.type === 'pong' && msg.source === 'terminal-client') {
              return true;
            }
            if (msg.type === 'resyncSuggested') {
              parserRecoveryNeeded = true;
              scheduleParserRecoveryResync(0);
              return true;
            }
            if (msg.type === 'cwd' && msg.cwd) {
              onCwdChange?.(msg.cwd);
              return true;
            }
            if (msg.type === 'threadUpdate' && msg.thread) {
              syncSessionThread(sessionId, msg.thread);
              return true;
            }
            return false;
          };

          const processMessageQueue = async () => {
            if (processingQueue) return;
            processingQueue = true;

            while (messageQueue.length > 0 && !disposed) {
              const event = messageQueue.shift();
              if (!event) break;

              const decoded = await decodeSocketData(event.data);
              if (disposed) break;

              lastServerPingAtRef.current = Date.now();
              if (decoded.type === 'meta') {
                try {
                  const msg = JSON.parse(decoded.payload);
                  if (handleMetaMessage(msg)) {
                    continue;
                  }
                } catch {
                  // fall through
                }
              }

              let data = decoded.payload;
              if (data === '__terminal_pong__') continue;
              if (typeof data === 'string' && data.includes('__terminal_ping__')) {
                data = data.split('__terminal_ping__').join('');
              }
              if (typeof data === 'string' && data.includes('{"type":"ping","source":"terminal-client"}')) {
                data = data.split('{"type":"ping","source":"terminal-client"}').join('');
              }
              if (!data) continue;

              if (typeof data === 'string' && data.startsWith('{')) {
                try {
                  const msg = JSON.parse(data);
                  if (handleMetaMessage(msg)) continue;
                } catch { /* Not valid JSON */ }
              }

              if (historyReloadingRef.current) {
                pendingSocketDataRef.current.push({
                  text: data,
                  seq: pendingServerSeqRef.current ?? undefined
                });
                pendingServerSeqRef.current = null;
                continue;
              }

              enqueueTerminalWrite(data, pendingServerSeqRef.current);
              pendingServerSeqRef.current = null;
            }

            processingQueue = false;
          };

          socket.onmessage = (event) => {
            if (disposed) return;
            messageQueue.push(event);
            if (messageQueue.length > MAX_MESSAGE_QUEUE) {
              const overflow = messageQueue.length - MAX_MESSAGE_QUEUE;
              messageQueue.splice(0, overflow);
              droppedEventCountRef.current += overflow;
              parserRecoveryNeeded = true;
              tailModeRef.current = true;
              scheduleParserRecoveryResync(0);
            }
            void processMessageQueue();
          };

          socket.onerror = () => {
            if (disposed) return;
            if (connectTimeout) {
              clearTimeout(connectTimeout);
              connectTimeout = null;
            }
            markDisconnected();
            if (!hadConnectionError) {
              hadConnectionError = true;
              writeTerminal('\r\n[Connection lost – attempting to reconnect…]\r\n');
            }
          };

          socket.onclose = (event) => {
            if (disposed) return;
            if (connectTimeout) {
              clearTimeout(connectTimeout);
              connectTimeout = null;
            }
            markDisconnected();
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            messageQueue.length = 0;
            if (event.reason === 'Session ended') {
              const sessionSnapshot = sessionsRef.current.find((session) => session.id === sessionId);
              const shouldTryRestore = !restoreRetryAttemptedRef.current
                && typeof restoreSessionRef.current === 'function'
                && (!sessionSnapshot || !sessionSnapshot.isActive);

              if (shouldTryRestore) {
                restoreRetryAttemptedRef.current = true;
                writeTerminal('\r\n[Session inactive - restoring...]\r\n');
                void restoreSessionRef.current(sessionId)
                  .then(() => {
                    if (disposed || pausedForOfflineRef.current) return;
                    setTimeout(() => {
                      if (!disposed) {
                        connectSocket();
                      }
                    }, 120);
                  })
                  .catch(() => {
                    if (!restoreAttempt2Ref.current) {
                      restoreAttempt2Ref.current = true;
                      setTimeout(() => {
                        void restoreSessionRef.current(sessionId)
                          .then(() => {
                            if (disposed || pausedForOfflineRef.current) return;
                            setTimeout(() => { if (!disposed) connectSocket(); }, 120);
                          })
                          .catch(() => {
                            setIsLoadingHistory(false);
                            writeTerminal('\r\n[Session restore failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
                            const nextDelay = restoreRetryDelay;
                            restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
                            setTimeout(() => { if (!disposed) connectSocket(); }, nextDelay);
                          });
                      }, 2000);
                    } else {
                      setIsLoadingHistory(false);
                      writeTerminal('\r\n[Session restore failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
                      const nextDelay = restoreRetryDelay;
                      restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
                      setTimeout(() => { if (!disposed) connectSocket(); }, nextDelay);
                    }
                  });
                return;
              }
              setIsLoadingHistory(false);
              writeTerminal('\r\n[Session restore failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
              const nextDelayA = restoreRetryDelay;
              restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
              setTimeout(() => { if (!disposed) connectSocket(); }, nextDelayA);
              return;
            }
            if (event.reason === 'Terminal session not found' || event.code === 4404) {
              if (!restoreRetryAttemptedRef.current && typeof restoreSessionRef.current === 'function') {
                restoreRetryAttemptedRef.current = true;
                writeTerminal('\r\n[Session inactive - restoring...]\r\n');
                void restoreSessionRef.current(sessionId)
                  .then(() => {
                    if (disposed || pausedForOfflineRef.current) return;
                    setTimeout(() => { if (!disposed) connectSocket(); }, 120);
                  })
                  .catch(() => {
                    setIsLoadingHistory(false);
                    writeTerminal('\r\n[Session restore failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
                    const nextDelayB = restoreRetryDelay;
                    restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
                    setTimeout(() => { if (!disposed) connectSocket(); }, nextDelayB);
                  });
              } else {
                setIsLoadingHistory(false);
                writeTerminal('\r\n[Session restore failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
                const nextDelayC = restoreRetryDelay;
                restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
                setTimeout(() => { if (!disposed) connectSocket(); }, nextDelayC);
              }
              return;
            }
            if (event.reason === 'Unauthorized' || event.code === 4401) {
              refreshTokens()
                .then(() => {
                  if (!disposed && shouldReconnect) {
                    wsRetryCount++;
                    const delay = Math.min(1000 * Math.pow(2, wsRetryCount - 1), MAX_WS_RETRY_DELAY);
                    setTimeout(connectSocket, delay);
                  }
                })
                .catch(() => {
                  if (authRetryCount >= 3) {
                    handleAuthFailure('Session expired - please refresh');
                  } else {
                    authRetryCount++;
                    setIsLoadingHistory(false);
                    writeTerminal('\r\n[Auth failed – retrying in ' + Math.round(restoreRetryDelay / 1000) + 's...]\r\n');
                    const nextDelayD = restoreRetryDelay;
                    restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
                    setTimeout(() => { if (!disposed) connectSocket(); }, nextDelayD);
                  }
                });
              return;
            }
            if (shouldReconnect && !pausedForOfflineRef.current) {
              wsRetryCount++;
              const baseDelay = Math.min(1000 * Math.pow(2, wsRetryCount - 1), MAX_WS_RETRY_DELAY);
              const jitter = Math.random() * 500;
              setTimeout(connectSocket, baseDelay + jitter);
            }
          };
        };

        void startSocket();

        return () => {
          shouldReconnect = false;
          if (skipUrlTimeout) clearTimeout(skipUrlTimeout);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (connectTimeout) clearTimeout(connectTimeout);
          if (incrementalResyncTimer) {
            clearTimeout(incrementalResyncTimer);
            incrementalResyncTimer = null;
          }
          if (fullHistoryResyncTimer) {
            clearTimeout(fullHistoryResyncTimer);
            fullHistoryResyncTimer = null;
          }
          if (socket) socket.close();
        };
      };

      const closeSocket = connectSocket();

      const dataDisposer = term.onData((data) => {
        if (disposed) return;
        if (term._isComposing && term._isComposing()) return;

        if (isTerminalControlResponseInput(data)) return;

        exitCopyModeIfActive();
        markUserInput();
        resetIdleTimer(false);
        const ownerClientId = ptyOwnerStateRef.current.ownerClientId;
        const currentClientId = clientIdRef.current;
        const shouldAwaitPromotion = Boolean(
          syncPtySizeRef.current &&
          currentClientId &&
          ownerClientId &&
          ownerClientId !== currentClientId
        );
        if (shouldAwaitPromotion) {
          awaitOwnerPromotionBeforeInput();
        }
        syncPtySize({ clientId: clientIdRef.current || undefined, priorityOverride: true });
        queueTerminalInput(data);
      });

      const handleResize = () => debouncedFit(100);
      window.addEventListener('resize', handleResize);

      let resizeTimeout = null;
      const resizeDisposer = term.onResize(({ cols, rows }) => {
        if (!syncPtySizeRef.current) return;
        if (disposed) return;
        if (suppressResizeSyncCount > 0) return;
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (!syncPtySizeRef.current) return;
          if (disposed) return;
          syncPtySize({ clientId: clientIdRef.current || undefined, dims: { cols, rows } });
        }, isMobile ? 80 : 30);
      });

      const VIEWPORT_JITTER_THRESHOLD = 8;
      let lastViewportWidth = null;
      let lastViewportHeight = null;
      const viewport = window.visualViewport;
      const handleViewportResize = () => {
        if (!viewport) return;
        const nextWidth = Math.round(viewport.width);
        const nextHeight = Math.round(viewport.height);
        if (lastViewportWidth !== null && lastViewportHeight !== null) {
          const widthDelta = Math.abs(nextWidth - lastViewportWidth);
          const heightDelta = Math.abs(nextHeight - lastViewportHeight);
          if (widthDelta < VIEWPORT_JITTER_THRESHOLD && heightDelta < VIEWPORT_JITTER_THRESHOLD) {
            return;
          }
        }
        lastViewportWidth = nextWidth;
        lastViewportHeight = nextHeight;
        debouncedFit(100);
      };
      if (viewport) {
        lastViewportWidth = Math.round(viewport.width);
        lastViewportHeight = Math.round(viewport.height);
        viewport.addEventListener('resize', handleViewportResize);
      }

      const handleContextMenu = async (e) => {
        if (isMobile) return; // On mobile, let the system paste menu appear naturally
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          sendPastedText(text);
        } catch (err) {
          console.error('Failed to read clipboard:', err);
        }
      };
      container.addEventListener('contextmenu', handleContextMenu);

      const handlePasteEvent = async (e) => {
        if (suppressPasteEventRef.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const clipboardData = e.clipboardData;
        if (!clipboardData) {
          handleClipboardPaste();
          return;
        }

        const text = clipboardData.getData('text/plain') || clipboardData.getData('text');
        const shouldSendText = shouldSendTextBeforeImage(text);

        let imageFile = null;
        try {
          imageFile = await getImageFileFromDataTransfer(clipboardData);
        } catch (error) {
          console.error('Failed to inspect clipboard image data:', error);
        }
        if (imageFile && !shouldSendText) {
          e.preventDefault();
          e.stopPropagation();
          uploadScreenshot(imageFile)
            .then((path) => {
              if (path) {
                sendPastedText(path + ' ');
              }
            })
            .catch((error) => {
              console.error('Failed to paste image:', error);
            });
          return;
        }

        if (shouldSendText) {
          e.preventDefault();
          e.stopPropagation();
          sendPastedText(text);
          return;
        }

        if (imageFile) {
          e.preventDefault();
          e.stopPropagation();
          uploadScreenshot(imageFile)
            .then((path) => {
              if (path) {
                sendPastedText(path + ' ');
              }
            })
            .catch((error) => {
              console.error('Failed to paste image:', error);
            });
          return;
        }

        handleClipboardPaste();
      };
      container.addEventListener('paste', handlePasteEvent, true);

      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('focus', handleFocus);
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        container.removeEventListener('contextmenu', handleContextMenu);
        container.removeEventListener('paste', handlePasteEvent, true);
        if (textarea) {
          textarea.removeEventListener('compositionstart', handleCompositionStart);
          textarea.removeEventListener('compositionend', handleCompositionEnd);
        }
        closeSocket?.();
        if (resizeTimeout) clearTimeout(resizeTimeout);
        scrollDisposer?.dispose();
        resizeDisposer?.dispose();
        dataDisposer?.dispose();
        if (viewport) viewport.removeEventListener('resize', handleViewportResize);
        if (openRetryTimeout) {
          clearTimeout(openRetryTimeout);
          openRetryTimeout = null;
        }
        if (iosRefreshRaf) {
          cancelAnimationFrame(iosRefreshRaf);
          iosRefreshRaf = null;
        }
        if (fitTimeoutRef.current) {
          clearTimeout(fitTimeoutRef.current);
          fitTimeoutRef.current = null;
        }
        if (fitRafRef.current) {
          cancelAnimationFrame(fitRafRef.current);
          fitRafRef.current = null;
        }
        pendingFitOptionsRef.current = null;
        if (webglAddonRef.current) {
          try {
            webglAddonRef.current.dispose();
          } catch {}
          webglAddonRef.current = null;
        }
      };
    };

    rafId = requestAnimationFrame(openWhenReady);

    return () => {
      disposed = true;
      detectedUrlsRef.current.clear();
      clientIdRef.current = null;
      ptyOwnerStateRef.current = {
        isOwner: null,
        ownerClientId: null,
        appliedCols: null,
        appliedRows: null
      };
      if (unregisterTerminalSender) {
        unregisterTerminalSender(sessionId, sendUserInput);
      }
      if (inputFlushRef.current) {
        clearTimeout(inputFlushRef.current);
        inputFlushRef.current = null;
      }
      if (ownerPromotionTimerRef.current) {
        clearTimeout(ownerPromotionTimerRef.current);
        ownerPromotionTimerRef.current = null;
      }
      pendingOwnerPromotionRef.current = false;
      ownerPromotionDeadlineRef.current = 0;
      inputBufferRef.current = '';
      if (rafId) cancelAnimationFrame(rafId);
      if (openRetryTimeout) {
        clearTimeout(openRetryTimeout);
        openRetryTimeout = null;
      }
      if (iosRefreshRaf) {
        cancelAnimationFrame(iosRefreshRaf);
        iosRefreshRaf = null;
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (fitRafRef.current) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      pendingFitOptionsRef.current = null;
      cleanupIdle();
      cleanupScrolling();
      if (resizeObserver) resizeObserver.disconnect();
      if (openWhenReady.cleanup) openWhenReady.cleanup();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose();
        } catch {}
        webglAddonRef.current = null;
      }
      loadMoreHistoryRef.current = null;
      reconnectSocketRef.current = null;
      sendTerminalInputRef.current = null;
      enqueueExternalInputRef.current = null;
      pendingExternalInputRef.current = [];
      externalInputFramesRef.current = [];
      nextExternalInputAtRef.current = 0;
      if (externalInputTimerRef.current) {
        clearTimeout(externalInputTimerRef.current);
        externalInputTimerRef.current = null;
      }
      requestAuthoritativeResizeRef.current = null;
      requestPriorityResizeRef.current = null;
    };
  // Note: fontSize intentionally excluded - handled by separate effect below
  // Callbacks like onActivityChange, onConnectionChange, onCwdChange are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onUrlDetected, isMobile, platformConfig.fontSize, platformConfig.scrollback, platformConfig.webglEnabled]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (!term.element) return;

    const shouldEnableWebgl = platformConfig.webglEnabled;
    if (shouldEnableWebgl) {
      if (!webglAddonRef.current) {
        try {
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            console.warn('[WebGL] Context lost, falling back to canvas renderer');
            try {
              webglAddon.dispose();
            } catch {}
            if (webglAddonRef.current === webglAddon) {
              webglAddonRef.current = null;
            }
            scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true });
          });
          term.loadAddon(webglAddon);
          webglAddonRef.current = webglAddon;
          scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true, clearAtlas: true });
        } catch (error) {
          console.warn('[WebGL] Failed to initialize, using canvas fallback:', error);
        }
      }
      return;
    }

    if (webglAddonRef.current) {
      try {
        webglAddonRef.current.dispose();
      } catch {}
      webglAddonRef.current = null;
      scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true });
    }
  }, [platformConfig.webglEnabled, scheduleViewportRefresh]);

  // Handle font size changes without recreating terminal
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current) return;
    const term = xtermRef.current;
    const newSize = platformConfig.fontSize;
    if (term.options.fontSize !== newSize) {
      term.options.fontSize = newSize;
      scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true, clearAtlas: true });
    }
  }, [platformConfig.fontSize, scheduleViewportRefresh]);

  // Handle keybar/viewport changes with debounced fit
  // Use shorter debounce on mobile for faster keyboard response
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    const debounceTime = 100;
    scheduleViewportRefresh({ delay: debounceTime, fit: true, preserveBottom: true });
    // Second fit after any CSS transitions settle (300ms max transition + buffer)
    const safetyFit = setTimeout(() => {
      scheduleViewportRefresh({ delay: 0, fit: true, preserveBottom: true });
    }, 350);
    return () => clearTimeout(safetyFit);
  }, [keybarOpen, viewportHeight, isMobile, scheduleViewportRefresh]);

  // External fit signal (e.g., preview split resize)
  useEffect(() => {
    if (fitSignal === undefined || fitSignal === null) return;
    if (!fitAddonRef.current || !xtermRef.current) return;
    scheduleViewportRefresh({ immediate: true, fit: true, preserveBottom: true });
  }, [fitSignal, scheduleViewportRefresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let dprMediaQuery = null;
    let orientationTimer = null;

    const scheduleStrongRefresh = (delay = 100) => {
      scheduleViewportRefresh({ delay, fit: true, preserveBottom: true, clearAtlas: true });
    };

    const removeDprListener = () => {
      if (!dprMediaQuery) return;
      if (typeof dprMediaQuery.removeEventListener === 'function') {
        dprMediaQuery.removeEventListener('change', handleDprChange);
      } else if (typeof dprMediaQuery.removeListener === 'function') {
        dprMediaQuery.removeListener(handleDprChange);
      }
      dprMediaQuery = null;
    };

    const bindDprListener = () => {
      removeDprListener();
      if (typeof window.matchMedia !== 'function') return;
      dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      if (typeof dprMediaQuery.addEventListener === 'function') {
        dprMediaQuery.addEventListener('change', handleDprChange);
      } else if (typeof dprMediaQuery.addListener === 'function') {
        dprMediaQuery.addListener(handleDprChange);
      }
    };

    function handleDprChange() {
      bindDprListener();
      scheduleStrongRefresh(80);
    }

    const handleOrientationChange = () => {
      scheduleStrongRefresh(120);
      if (orientationTimer) clearTimeout(orientationTimer);
      orientationTimer = setTimeout(() => {
        scheduleStrongRefresh(240);
      }, 180);
    };

    bindDprListener();
    if (isMobile) {
      window.addEventListener('orientationchange', handleOrientationChange);
    }
    return () => {
      if (isMobile) {
        window.removeEventListener('orientationchange', handleOrientationChange);
      }
      if (orientationTimer) {
        clearTimeout(orientationTimer);
        orientationTimer = null;
      }
      removeDprListener();
    };
  }, [isMobile, scheduleViewportRefresh]);

  useEffect(() => () => {
    if (copiedBannerTimerRef.current) {
      clearTimeout(copiedBannerTimerRef.current);
      copiedBannerTimerRef.current = null;
    }
  }, []);

  // On mobile, control keyboard by moving textarea on/off screen
  useEffect(() => {
    if (!isMobile) return;
    if (keybarOpen && requestPriorityResizeRef.current) {
      try {
        requestPriorityResizeRef.current();
      } catch {
        // Ignore transient resize/promotion failures during mount/reconnect.
      }
    }
    setMobileInputEnabled(keybarOpen);
  }, [isMobile, keybarOpen, setMobileInputEnabled]);

  const shouldShowMirrorBadge = (
    viewMode === 'terminal'
    && (
      syncPtySize === false
      || ptyOwnerState.isOwner === false
    )
  );
  const shouldShowOwnerBadge = (
    viewMode === 'terminal'
    && !shouldShowMirrorBadge
    && ptyOwnerState.isOwner === true
    && !isPrimary
  );
  const ptyBadgeLabel = shouldShowMirrorBadge ? 'Mirror mode' : (shouldShowOwnerBadge ? 'PTY owner' : '');
  const ptyBadgeDims = (
    Number.isFinite(ptyOwnerState.appliedCols)
    && Number.isFinite(ptyOwnerState.appliedRows)
  )
    ? `${ptyOwnerState.appliedCols}x${ptyOwnerState.appliedRows}`
    : '';

  return (
    <div
      className={`terminal-chat ${platformConfig.rootClassName}${isScrollMode ? ' scroll-mode' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleImageDrop}
      onClick={handleTerminalTap}
      onTouchStartCapture={handleTouchStartCapture}
      onTouchMoveCapture={handleTouchMoveCapture}
      onTouchEndCapture={handleTouchEndCapture}
      onTouchCancelCapture={handleTouchCancelCapture}
    >
      <div
        ref={terminalRef}
        className="xterm-container"
        style={{
          visibility: viewMode === 'terminal' ? 'visible' : 'hidden',
          pointerEvents: viewMode === 'terminal' ? 'auto' : 'none'
        }}
      ></div>
      {/* Mobile keyboard input overlay - always visible and tappable for iOS */}
      {isMobile && viewMode === 'terminal' && (
        <input
          ref={mobileInputRef}
          type="text"
          className="mobile-keyboard-input"
          onInput={handleMobileInput}
          onKeyDown={handleMobileKeyDown}
          onPaste={handleMobilePaste}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck="false"
          inputMode="text"
          enterKeyHint="send"
          aria-label="Terminal input"
        />
      )}
      {viewMode === 'reader' && (
        <ReaderView
          content={readerBuffer}
          lines={readerLines}
          lineHeight={readerLineHeight}
          scrollToken={readerScrollToken}
          fontSize={platformConfig.fontSize}
          onScrollDirection={onScrollDirection}
          onViewportStateChange={onViewportStateChange}
          onLoadMore={handleReaderLoadMore}
          onInput={handleReaderInput}
          isMobile={isMobile}
        />
      )}

      {!isMobile && isScrollMode && (
        <div className="terminal-scroll-mode-hint">Scroll mode — tap to type</div>
      )}
      {viewMode === 'terminal' && isCopyMode && (
        <div className="terminal-copy-mode-banner">
          <span>Copy mode - output paused</span>
          <button
            type="button"
            className="terminal-copy-mode-exit"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLatestOutput(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLatestOutput(); }}
          >
            Return to live
          </button>
        </div>
      )}
      {showCopiedBanner && (
        <div className="terminal-copy-feedback-banner" role="status" aria-live="polite">
          Copied
        </div>
      )}

      <button
        className="terminal-image-btn"
        onClick={triggerFileInput}
        title="Upload image"
        aria-label="Upload image"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </button>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageSelect}
      />

      {imageDragOver && (
        <div className="terminal-image-dropzone">
          <span>Drop image to upload</span>
        </div>
      )}

      {isLoadingHistory && (
        <div className="terminal-loading-indicator">
          <span className="terminal-loading-spinner"></span>
          <span>Loading history...</span>
        </div>
      )}
      {isLoadingMoreHistory && !isLoadingHistory && (
        <div className="terminal-loading-indicator">
          <span className="terminal-loading-spinner"></span>
          <span>Loading more history...</span>
        </div>
      )}
      {(isMobile || isScrollMode || isCopyMode) && (
        <div className={`terminal-scroll-buttons ${isMobile ? 'mobile' : 'desktop'}`}>
          <button
            className="scroll-btn scroll-up"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); scrollUp(); triggerLoadMoreIfAtTop(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); startScrolling('up'); triggerLoadMoreIfAtTop(); }}
            onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); stopScrolling(); }}
            onMouseDown={() => startScrolling('up')}
            onMouseUp={stopScrolling}
            onMouseLeave={stopScrolling}
            aria-label="Scroll up"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            className="scroll-btn scroll-down"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); scrollDown(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); startScrolling('down'); }}
            onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); stopScrolling(); }}
            onMouseDown={() => startScrolling('down')}
            onMouseUp={stopScrolling}
            onMouseLeave={stopScrolling}
            aria-label="Scroll down"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            className="scroll-btn scroll-live"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLatestOutput(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLatestOutput(); }}
            aria-label="Jump to live output"
            title="Jump to live output"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 13 12 18 17 13" />
              <polyline points="7 6 12 11 17 6" />
            </svg>
          </button>
        </div>
      )}
      <TerminalHistoryModal
        isOpen={historyModalOpen}
        sessionId={sessionId}
        onClose={() => setHistoryModalOpen(false)}
      />
    </div>
  );
}
