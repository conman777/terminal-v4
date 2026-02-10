import { useEffect, useRef, useCallback, useState } from 'react';
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

const TERMINAL_THEMES = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(255, 255, 255, 0.15)',
  },
  light: {
    background: '#fafaf9',
    foreground: '#1e1e1e',
    cursor: '#1e1e1e',
    cursorAccent: '#fafaf9',
    selectionBackground: 'rgba(0, 0, 0, 0.12)',
  }
};

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, webglEnabled, onScrollDirection, onRegisterImageUpload, onRegisterHistoryPanel, onRegisterFocusTerminal, onRegisterReconnect, onActivityChange, onConnectionChange, onCwdChange, usesTmux, fitSignal, viewMode = 'terminal', isPrimary = false, skipHistory = false, syncPtySize = true }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const webglAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const clientIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const inputFlushRef = useRef(null);
  const mobileInputRef = useRef(null);
  const { theme } = useTheme();
  const isMobile = useMobileDetect();
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
  const { activeSessionId, sessions, registerTerminalSender, unregisterTerminalSender } = useTerminalSession();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [isScrollMode, setIsScrollMode] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [isCopyMode, setIsCopyMode] = useState(false);
  const { buffer: readerBuffer, append: appendToReader, clear: clearReader, replace: replaceReaderBuffer } = useTerminalBuffer();
  const [readerLines, setReaderLines] = useState(null);
  const [readerLineHeight, setReaderLineHeight] = useState(null);
  const readerLineHeightRef = useRef(null);
  const [readerScrollToken, setReaderScrollToken] = useState(0);
  const sendTerminalInputRef = useRef(null);
  const fitTimeoutRef = useRef(null);
  const onScrollDirectionRef = useRef(onScrollDirection);
  const usesTmuxRef = useRef(Boolean(usesTmux));
  const webglEnabledRef = useRef(webglEnabled !== false);
  const scrollModeRef = useRef(false);
  const viewModeRef = useRef(viewMode);
  const isPrimaryRef = useRef(isPrimary);
  const syncPtySizeRef = useRef(syncPtySize !== false);
  const readerSyncRef = useRef(null);
  const droppedOutputRef = useRef(0);
  const droppedEventCountRef = useRef(0);
  const tailModeRef = useRef(false);
  const lastDropNoticeAtRef = useRef(0);
  const HISTORY_PAGE_EVENTS_DESKTOP = 10000;
  const HISTORY_PAGE_CHARS_DESKTOP = 5_000_000;
  const HISTORY_MAX_EVENTS_DESKTOP = 100_000;
  const HISTORY_MAX_CHARS_DESKTOP = 20_000_000;
  const HISTORY_PAGE_EVENTS_MOBILE = 1000;
  const HISTORY_PAGE_CHARS_MOBILE = 300_000;
  const HISTORY_MAX_EVENTS_MOBILE = 10_000;
  const HISTORY_MAX_CHARS_MOBILE = 2_000_000;
  const SCROLLBACK_DESKTOP = 100000;
  const SCROLLBACK_MOBILE = 10000;
  const READER_MAX_LINES_MOBILE = 2000;
  const HISTORY_WRITE_CHUNK_DESKTOP = 120000;
  const HISTORY_WRITE_CHUNK_MOBILE = 20000;
  const historyStateRef = useRef({
    pageEvents: HISTORY_PAGE_EVENTS_DESKTOP,
    pageChars: HISTORY_PAGE_CHARS_DESKTOP,
    maxHistoryEvents: HISTORY_MAX_EVENTS_DESKTOP,
    maxHistoryChars: HISTORY_MAX_CHARS_DESKTOP,
    exhausted: false,
    loading: false,
    lastCount: 0,
    lastChars: 0,
    lastLoadAt: 0,
    oldestTs: null,
    newestTs: null
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
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isActiveSession = sessionId === activeSessionId;
  const getHistoryConfig = useCallback(() => ({
    pageEvents: isMobile ? HISTORY_PAGE_EVENTS_MOBILE : HISTORY_PAGE_EVENTS_DESKTOP,
    pageChars: isMobile ? HISTORY_PAGE_CHARS_MOBILE : HISTORY_PAGE_CHARS_DESKTOP,
    maxEvents: isMobile ? HISTORY_MAX_EVENTS_MOBILE : HISTORY_MAX_EVENTS_DESKTOP,
    maxChars: isMobile ? HISTORY_MAX_CHARS_MOBILE : HISTORY_MAX_CHARS_DESKTOP
  }), [isMobile]);

  const applyHistoryConfig = useCallback(() => {
    const config = getHistoryConfig();
    historyStateRef.current.pageEvents = config.pageEvents;
    historyStateRef.current.pageChars = config.pageChars;
    historyStateRef.current.maxHistoryEvents = config.maxEvents;
    historyStateRef.current.maxHistoryChars = config.maxChars;
  }, [getHistoryConfig]);

  const resetHistoryCache = useCallback(() => {
    historyEntriesRef.current = [];
    historyTextRef.current = '';
    historyCharCountRef.current = 0;
    historyStateRef.current.lastCount = 0;
    historyStateRef.current.lastChars = 0;
    historyStateRef.current.oldestTs = null;
    historyStateRef.current.newestTs = null;
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
  }, [updateHistoryText]);

  const setHistoryEntries = useCallback((entries) => {
    historyEntriesRef.current = entries;
    historyCharCountRef.current = entries.reduce((sum, entry) => sum + (entry?.text?.length || 0), 0);
    updateHistoryText();
    historyStateRef.current.lastCount = entries.length;
    historyStateRef.current.lastChars = historyCharCountRef.current;
    historyStateRef.current.oldestTs = entries[0]?.ts ?? null;
    historyStateRef.current.newestTs = entries.length > 0 ? entries[entries.length - 1]?.ts ?? null : null;
  }, [updateHistoryText]);

  const appendHistoryEntry = useCallback((entry) => {
    if (!entry?.text) return;
    historyEntriesRef.current.push(entry);
    historyCharCountRef.current += entry.text.length;
    historyTextRef.current += entry.text;
    historyStateRef.current.newestTs = entry.ts ?? historyStateRef.current.newestTs;
    trimHistoryEntries();
  }, [trimHistoryEntries]);

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
      jumpToLive();
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

    const buildDefaultPalette = () => {
      const base = [
        '#2e3436', '#cc0000', '#4e9a06', '#c4a000',
        '#3465a4', '#75507b', '#06989a', '#d3d7cf',
        '#555753', '#ef2929', '#8ae234', '#fce94f',
        '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
      ];
      const palette = base.slice();
      const steps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
      const toHex = (value) => value.toString(16).padStart(2, '0');
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
    };

    const ansiPalette = Array.isArray(themeColors?.ansi) && themeColors.ansi.length >= 16
      ? themeColors.ansi.map((color) => color?.css || defaultFg)
      : buildDefaultPalette();

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
    const maxLines = isMobile ? READER_MAX_LINES_MOBILE : bufferLineCount;
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
  }, [isMobile, replaceReaderBuffer]);

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
    const newTheme = TERMINAL_THEMES[theme] || TERMINAL_THEMES.dark;
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
    setMobileInputEnabled(true);
  }, [isMobile, setMobileInputEnabled, setScrollMode, viewMode]);

  // Touch gesture handling
  const handleLongPress = useCallback(() => {
    if (!isMobile) return;
    toggleScrollMode();
  }, [isMobile, toggleScrollMode]);

  const handleTouchMove = useCallback((info) => {
    const term = xtermRef.current;
    if (!term) return;
    const deltaY = info?.deltaY || 0;
    const deltaX = info?.deltaX || 0;
    if (!deltaY) return;

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
  }, [scrollByWheel, triggerLoadMoreIfAtTop]);

  const {
    touchStateRef,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleTouchCancelCapture
  } = useTouchGestures(isMobile, handleTerminalTap, {
    onLongPress: handleLongPress,
    onMove: handleTouchMove
  });

  // Keep ref updated to avoid stale closures
  useEffect(() => {
    onScrollDirectionRef.current = onScrollDirection;
  }, [onScrollDirection]);

  useEffect(() => {
    usesTmuxRef.current = Boolean(usesTmux);
  }, [usesTmux]);

  useEffect(() => {
    syncPtySizeRef.current = syncPtySize !== false;
  }, [syncPtySize]);

  useEffect(() => {
    webglEnabledRef.current = webglEnabled !== false;
  }, [webglEnabled]);

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

  // Reset loading state when session changes
  useEffect(() => {
    shouldReplayHistoryRef.current = !skipHistory;
    setIsLoadingMoreHistory(false);
    applyHistoryConfig();
    historyStateRef.current.exhausted = false;
    historyStateRef.current.loading = false;
    historyStateRef.current.lastCount = 0;
    historyStateRef.current.lastChars = 0;
    historyStateRef.current.lastLoadAt = 0;
    historyStateRef.current.oldestTs = null;
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

  // Register focus terminal trigger for iOS keyboard activation
  useEffect(() => {
    if (onRegisterFocusTerminal) {
      onRegisterFocusTerminal(() => setMobileInputEnabled(true));
    }
  }, [onRegisterFocusTerminal, setMobileInputEnabled]);

  // Register reconnect trigger for external mobile controls.
  useEffect(() => {
    if (!onRegisterReconnect) return;
    onRegisterReconnect(() => {
      reconnectSocketRef.current?.();
    });
    return () => {
      onRegisterReconnect(null);
    };
  }, [onRegisterReconnect]);

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
    const MIN_CONTAINER_WIDTH = 50;
    const MIN_CONTAINER_HEIGHT = 30;

    const scrollback = performanceMode
      ? (isMobile ? SCROLLBACK_MOBILE : SCROLLBACK_DESKTOP)
      : (isMobile ? SCROLLBACK_MOBILE * 2 : SCROLLBACK_DESKTOP * 3);
    const defaultTerminalFontSize = fontSize || (isMobile ? 16 : 14);
    const terminalFontFamily = isMobile
      ? 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace'
      : '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';

    const term = new Terminal({
      cursorBlink: false,
      fontSize: defaultTerminalFontSize,
      fontFamily: terminalFontFamily,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback,
      theme: TERMINAL_THEMES[theme] || TERMINAL_THEMES.dark,
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

    const writeTerminal = (text, callback) => {
      if (typeof callback === 'function') {
        term.write(text, () => {
          callback();
          scheduleIOSRefresh();
        });
        return;
      }
      term.write(text);
      scheduleIOSRefresh();
    };

    const sendTerminalInput = (text) => {
      if (!text || disposed) return;
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(text);
        return;
      }
      apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: text }
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
      queueTerminalInput(text);
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
      if (width < MIN_CONTAINER_WIDTH || height < MIN_CONTAINER_HEIGHT) {
        openRetryCount++;
        if (openRetryCount === MAX_OPEN_RETRIES) {
          console.warn('[Terminal] Container never reached viable size after', MAX_OPEN_RETRIES, 'retries');
        }
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

      hasOpened = true;
      term.open(container);

      const requestPostOpenFit = () => {
        if (disposed || !fitAddonRef.current || !xtermRef.current) return;
        try {
          fitAddonRef.current.fit();
          const rows = xtermRef.current.rows || 0;
          if (rows > 0) {
            xtermRef.current.refresh(0, rows - 1);
          }
        } catch {}
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
        const shouldEnableWebgl = webglEnabledRef.current && !(isMobile && isIOS);
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
      term.attachCustomWheelEventHandler((event) => {
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
      const fetchHistoryPage = async ({ beforeTs, afterTs } = {}) => {
        const state = historyStateRef.current;
        const params = new URLSearchParams();
        params.set('historyEvents', String(state.pageEvents));
        params.set('historyChars', String(state.pageChars));
        if (beforeTs) {
          params.set('beforeTs', String(beforeTs));
        }
        if (afterTs) {
          params.set('afterTs', String(afterTs));
        }
        const response = await apiFetch(`/api/terminal/${sessionId}/history?${params.toString()}`);
        if (!response.ok) return null;
        const snapshot = await response.json();
        return Array.isArray(snapshot?.history) ? snapshot.history : [];
      };

      const writeHistoryChunks = (historyText) => new Promise((resolve) => {
        if (!historyText) {
          resolve();
          return;
        }
        const chunkSize = isMobile ? HISTORY_WRITE_CHUNK_MOBILE : HISTORY_WRITE_CHUNK_DESKTOP;
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
              requestAnimationFrame(writeNext);
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
        const pendingText = pending.join('');
        const shouldAppendReader = viewModeRef.current === 'reader' || !isMobile;
        if (viewModeRef.current === 'reader') {
          writeTerminal(pendingText, scheduleReaderSync);
        } else {
          writeTerminal(pendingText);
          if (shouldAppendReader) {
            appendToReader(pendingText);
          }
        }
        const now = Date.now();
        pending.forEach((chunk) => appendHistoryEntry({ text: chunk, ts: now }));
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
          const history = await fetchHistoryPage();
          if (!history) {
            setIsLoadingHistory(false);
            return;
          }
          setHistoryEntries(history);
          state.exhausted = history.length === 0;
          term.reset();
          clearReader();
          const historyText = historyTextRef.current;
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

      const loadMoreHistory = async () => {
        if (disposed) return;
        const state = historyStateRef.current;
        if (state.loading || state.exhausted || !state.oldestTs) return;
        const now = Date.now();
        if (now - state.lastLoadAt < 1500) return;

        state.loading = true;
        state.lastLoadAt = now;
        historyReloadingRef.current = true;
        setIsLoadingMoreHistory(true);

        try {
          const previousOldest = state.oldestTs;
          const history = await fetchHistoryPage({ beforeTs: state.oldestTs });
          if (!history || history.length === 0) {
            state.exhausted = true;
            return;
          }
          prependHistoryEntries(history);
          if (state.oldestTs === previousOldest) {
            state.exhausted = true;
          }

          const historyText = historyTextRef.current;
          term.reset();
          clearReader();
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
        if (state.loading || !state.newestTs) return;
        state.loading = true;
        state.lastLoadAt = Date.now();
        historyReloadingRef.current = true;
        setIsLoadingHistory(true);

        try {
          const history = await fetchHistoryPage({ afterTs: state.newestTs });
          if (!history || history.length === 0) return;
          history.forEach((entry) => appendHistoryEntry(entry));
          const combined = history.map((entry) => entry.text || '').join('');
          if (combined) {
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
      const scrollDisposer = term.onScroll((newPos) => {
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
        if (newPos === 0) {
          loadMoreHistory();
        }
        lastScrollPos = newPos;
      });

      rafId = requestAnimationFrame(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = term;
          if (syncPtySizeRef.current && cols && rows) {
            apiFetch(`/api/terminal/${sessionId}/resize`, {
              method: 'POST',
              body: isPrimaryRef.current && !isMobile ? { cols, rows, priority: true } : { cols, rows }
            }).catch(() => {});
          }
        }
      });

      const debouncedFit = () => {
        if (disposed) return;
        if (fitTimeoutRef.current) {
          clearTimeout(fitTimeoutRef.current);
        }
        fitTimeoutRef.current = setTimeout(() => {
          if (disposed || !fitAddonRef.current || !xtermRef.current) return;
          const container = terminalRef.current;
          if (!container) return;
          const { width, height } = container.getBoundingClientRect();
          if (width < MIN_CONTAINER_WIDTH || height < MIN_CONTAINER_HEIGHT) return;
          try {
            const buffer = xtermRef.current.buffer?.active;
            const wasAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
            fitAddonRef.current.fit();
            if (wasAtBottom) {
              xtermRef.current.scrollToBottom();
            }
          } catch { /* Ignore errors during rapid resizing */ }
        }, 150);
      };

      resizeObserver = new ResizeObserver(() => debouncedFit());
      resizeObserver.observe(container);

      const handleFocus = () => debouncedFit();
      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          debouncedFit();
          // Trigger reconnect if socket is closed and we're online
          if (navigator.onLine && socketRef.current?.readyState !== WebSocket.OPEN) {
            reconnectSocketRef.current?.();
          } else {
            scheduleIncrementalResync(0);
          }
        }
      };
      const handleOnline = () => {
        pausedForOfflineRef.current = false;
        // Attempt reconnect when coming back online
        if (socketRef.current?.readyState !== WebSocket.OPEN) {
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
        const token = getAccessToken();
        const base = import.meta.env.VITE_API_URL || window.location.origin;
        const url = new URL(`/api/terminal/${sessionId}/ws`, base);
        if (token) url.searchParams.set('token', token);
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
      const MAX_WS_RETRY_DELAY = 30000;

      const connectSocket = () => {
        if (disposed) return () => {};
        // Skip reconnect if we're offline
        if (pausedForOfflineRef.current) return () => {};
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
        let lastServerPingAt = 0;
        const messageQueue = [];
        let processingQueue = false;
        let didOpen = false;
        const HEARTBEAT_INTERVAL = 10000;
        const HEARTBEAT_TIMEOUT = isMobile ? 90000 : 45000;
        const CONNECT_TIMEOUT = isMobile ? 30000 : 15000;

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
            didOpen = true;
            if (connectTimeout) {
              clearTimeout(connectTimeout);
              connectTimeout = null;
            }
            wsRetryCount = 0;
            resetUserInput();
            onConnectionChange?.(true);
            lastServerPingAt = Date.now();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
              if (socket.readyState !== WebSocket.OPEN) return;
              const now = Date.now();
              if (now - lastServerPingAt > HEARTBEAT_TIMEOUT) {
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
          let pendingWriteFrame = null;
          let parserRecoveryNeeded = false;
          const flushPendingWrites = () => {
            if (disposed) return;
            pendingWriteFrame = null;
            if (parserRecoveryNeeded) {
              parserRecoveryNeeded = false;
              pendingWrite = '';
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

            if (historyReloadingRef.current) {
              pendingSocketDataRef.current.push(data);
              return;
            }

            const buffer = term.buffer?.active;
            const baseY = buffer?.baseY || 0;
            const viewportYBefore = buffer?.viewportY ?? 0;
            const wasAtBottom = buffer ? baseY === buffer.viewportY : true;

            appendHistoryEntry({ text: data, ts: Date.now() });

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

          const enqueueTerminalWrite = (data) => {
            if (!data) return;
            pendingWrite += data;
            if (pendingWrite.length > MAX_PENDING_WRITE_CHARS) {
              droppedOutputRef.current += pendingWrite.length;
              pendingWrite = '';
              parserRecoveryNeeded = true;
              tailModeRef.current = true;
              scheduleIncrementalResync(0);
            }
            if (pendingWriteFrame) return;
            pendingWriteFrame = requestAnimationFrame(flushPendingWrites);
          };

          const handleMetaMessage = (msg) => {
            if (!msg || typeof msg !== 'object') return false;
            if (msg.__terminal_meta) {
              msg = { ...msg, __terminal_meta: undefined };
            }
            if (msg.type === 'clientId' && msg.clientId && isValidClientId(msg.clientId)) {
              clientIdRef.current = msg.clientId;
              const { cols, rows } = term;
              if (syncPtySizeRef.current && cols && rows) {
                apiFetch(`/api/terminal/${sessionId}/resize`, {
                  method: 'POST',
                  body: isPrimaryRef.current && !isMobile
                    ? { cols, rows, clientId: msg.clientId, priority: true }
                    : { cols, rows, clientId: msg.clientId }
                }).catch(() => {});
              }
              return true;
            }
            if (msg.type === 'serverPing') {
              return true;
            }
            if (msg.type === 'pong' && msg.source === 'terminal-client') {
              return true;
            }
            if (msg.type === 'cwd' && msg.cwd) {
              onCwdChange?.(msg.cwd);
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

              lastServerPingAt = Date.now();
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
                pendingSocketDataRef.current.push(data);
                continue;
              }

              enqueueTerminalWrite(data);
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
              scheduleIncrementalResync(0);
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
              shouldReconnect = false;
              setIsLoadingHistory(false);
              writeTerminal('\r\n[Terminal session ended]\r\n');
              return;
            }
            if (event.reason === 'Terminal session not found' || event.code === 4404) {
              shouldReconnect = false;
              setIsLoadingHistory(false);
              writeTerminal('\r\n[Terminal session not found]\r\n');
              return;
            }
            if (event.reason === 'Unauthorized' || event.code === 4401) {
              handleAuthFailure('Session expired - please refresh');
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
          if (socket) socket.close();
        };
      };

      const closeSocket = connectSocket();

      const dataDisposer = term.onData((data) => {
        if (disposed) return;
        if (term._isComposing && term._isComposing()) return;

        const isQueryResponse = /^\x1b\[[\?>\d;]*[cn]$/.test(data) || /^\x1b\]/.test(data);
        if (isQueryResponse) return;

        exitCopyModeIfActive();
        markUserInput();
        resetIdleTimer(false);
        queueTerminalInput(data);
      });

      const handleResize = () => debouncedFit();
      window.addEventListener('resize', handleResize);

      let resizeTimeout = null;
      const resizeDisposer = term.onResize(({ cols, rows }) => {
        if (!syncPtySizeRef.current) return;
        if (disposed) return;
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (!syncPtySizeRef.current) return;
          if (disposed) return;
          const resizeBody = { cols, rows };
          if (clientIdRef.current) resizeBody.clientId = clientIdRef.current;
          if (isPrimaryRef.current && !isMobile) resizeBody.priority = true;
          apiFetch(`/api/terminal/${sessionId}/resize`, {
            method: 'POST',
            body: resizeBody
          }).catch((error) => {
            console.error('Failed to send resize:', error);
          });
        }, 100);
      });

      const viewport = window.visualViewport;
      if (viewport) viewport.addEventListener('resize', handleResize);

      const handleContextMenu = async (e) => {
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
        if (viewport) viewport.removeEventListener('resize', handleResize);
        if (openRetryTimeout) {
          clearTimeout(openRetryTimeout);
          openRetryTimeout = null;
        }
        if (iosRefreshRaf) {
          cancelAnimationFrame(iosRefreshRaf);
          iosRefreshRaf = null;
        }
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
      if (unregisterTerminalSender) {
        unregisterTerminalSender(sessionId, sendUserInput);
      }
      if (inputFlushRef.current) {
        clearTimeout(inputFlushRef.current);
        inputFlushRef.current = null;
      }
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
    };
  // Note: fontSize intentionally excluded - handled by separate effect below
  // Callbacks like onActivityChange, onConnectionChange, onCwdChange are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onUrlDetected, isMobile]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const shouldEnableWebgl = webglEnabledRef.current && !(isMobile && isIOS);
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
          });
          term.loadAddon(webglAddon);
          webglAddonRef.current = webglAddon;
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
    }
  }, [webglEnabled, isMobile, isIOS]);

  // Handle font size changes without recreating terminal
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current) return;
    const term = xtermRef.current;
    const newSize = fontSize || (isMobile ? 16 : 14);
    if (term.options.fontSize !== newSize) {
      term.options.fontSize = newSize;
      fitAddonRef.current.fit();
    }
  }, [fontSize, isMobile]);

  // Handle keybar/viewport changes with debounced fit
  // Use shorter debounce on mobile for faster keyboard response
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);

    const debounceTime = isMobile ? 50 : 150;
    fitTimeoutRef.current = setTimeout(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      try {
        const term = xtermRef.current;
        const buffer = term.buffer?.active;
        const wasAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
        fitAddonRef.current.fit();
        if (wasAtBottom) term.scrollToBottom();
      } catch (error) {
        console.error('[Terminal Fit] Failed to resize terminal:', error);
      }
    }, debounceTime);
  }, [keybarOpen, viewportHeight, isMobile]);

  // External fit signal (e.g., preview split resize)
  useEffect(() => {
    if (fitSignal === undefined || fitSignal === null) return;
    if (!fitAddonRef.current || !xtermRef.current) return;
    const rafId = requestAnimationFrame(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      try {
        const term = xtermRef.current;
        const buffer = term.buffer?.active;
        const wasAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
        fitAddonRef.current.fit();
        if (wasAtBottom) {
          term.scrollToBottom();
        }
      } catch (error) {
        console.error('[Terminal Fit] Failed to apply fit signal:', error);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [fitSignal]);

  // On mobile, control keyboard by moving textarea on/off screen
  useEffect(() => {
    if (!isMobile) return;
    setMobileInputEnabled(keybarOpen);
  }, [isMobile, keybarOpen, setMobileInputEnabled]);

  return (
    <div
      className={`terminal-chat${isScrollMode ? ' scroll-mode' : ''}`}
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
          fontSize={fontSize || (isMobile ? 16 : 14)}
          onScrollDirection={onScrollDirection}
          onLoadMore={handleReaderLoadMore}
          onInput={handleReaderInput}
          isMobile={isMobile}
        />
      )}

      {isMobile && isScrollMode && (
        <div className="terminal-scroll-mode-hint">Scroll mode — tap to type</div>
      )}
      {viewMode === 'terminal' && isCopyMode && (
        <div className="terminal-copy-mode-banner">
          <span>Copy mode - output paused</span>
          <button
            type="button"
            className="terminal-copy-mode-exit"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLive(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLive(); }}
          >
            Return to live
          </button>
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
      {(!isMobile || isScrollMode || isCopyMode) && (
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
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLive(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); jumpToLive(); }}
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
