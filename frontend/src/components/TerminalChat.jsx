import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch, uploadScreenshot } from '../utils/api';
import { getAccessToken } from '../utils/auth';
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

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, onScrollDirection, onRegisterImageUpload, onRegisterHistoryPanel, onRegisterFocusTerminal, onActivityChange, onConnectionChange, onCwdChange, usesTmux, viewMode = 'terminal' }) {
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
  const isMobile = useMobileDetect();
  const performanceMode = true;
  const { activeSessionId, sessions, registerTerminalSender, unregisterTerminalSender } = useTerminalSession();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [isScrollMode, setIsScrollMode] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const { buffer: readerBuffer, append: appendToReader, clear: clearReader, replace: replaceReaderBuffer } = useTerminalBuffer();
  const [readerLines, setReaderLines] = useState(null);
  const [readerCursor, setReaderCursor] = useState(null);
  const sendTerminalInputRef = useRef(null);
  const fitTimeoutRef = useRef(null);
  const onScrollDirectionRef = useRef(onScrollDirection);
  const usesTmuxRef = useRef(Boolean(usesTmux));
  const scrollModeRef = useRef(false);
  const viewModeRef = useRef(viewMode);
  const readerSyncRef = useRef(null);
  const INITIAL_HISTORY_EVENTS = 10000;
  const INITIAL_HISTORY_CHARS = 5000000;
  const HISTORY_MAX_EVENTS = 100000;
  const HISTORY_MAX_CHARS = 20000000;
  const SCROLLBACK_DESKTOP = 100000;
  const SCROLLBACK_MOBILE = 10000;
  const historyStateRef = useRef({
    maxHistoryEvents: INITIAL_HISTORY_EVENTS,
    maxHistoryChars: INITIAL_HISTORY_CHARS,
    exhausted: false,
    loading: false,
    lastCount: 0,
    lastChars: 0,
    lastLoadAt: 0
  });
  const historyReloadingRef = useRef(false);
  const pendingSocketDataRef = useRef([]);
  const loadMoreHistoryRef = useRef(null);
  const shouldReplayHistoryRef = useRef(true);
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isActiveSession = sessionId === activeSessionId;
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
    cleanup: cleanupScrolling
  } = useTerminalScrolling(xtermRef, sendToTerminal);

  // Mobile keyboard control
  const setMobileInputEnabled = useCallback((enabled) => {
    if (!isMobile) return;
    const term = xtermRef.current;
    if (!term) return;
    const textarea = term.textarea;
    if (!textarea) return;

    if (enabled) {
      textarea.style.left = '0';
      textarea.style.top = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.opacity = '0.01';
      textarea.style.zIndex = '1';
      textarea.style.pointerEvents = 'none';
      textarea.readOnly = false;
      textarea.inputMode = 'text';
      term.focus();
    } else {
      textarea.blur();
      textarea.style.left = '-9999px';
      textarea.style.opacity = '1';
      textarea.style.zIndex = '-1';
      textarea.style.pointerEvents = 'auto';
      textarea.readOnly = true;
      textarea.inputMode = 'none';
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
    if (!buffer) return;
    const hintText = 'Use /skills to list available skills';
    const contextRegex = /\b\d+% context left\b.*$/i;
    const sanitizeLine = (line, cursorColumnOverride) => {
      if (!line) {
        return { text: '', column: cursorColumnOverride };
      }
      const ranges = [];
      let searchFrom = 0;
      while (true) {
        const idx = line.indexOf(hintText, searchFrom);
        if (idx === -1) break;
        ranges.push([idx, idx + hintText.length]);
        searchFrom = idx + hintText.length;
      }
      const contextMatch = contextRegex.exec(line);
      if (contextMatch && typeof contextMatch.index === 'number') {
        ranges.push([contextMatch.index, line.length]);
      }

      if (ranges.length === 0) {
        return { text: line, column: cursorColumnOverride };
      }

      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (!last || range[0] > last[1]) {
          merged.push([...range]);
        } else {
          last[1] = Math.max(last[1], range[1]);
        }
      }

      let cursorColumn = cursorColumnOverride;
      let removed = 0;
      let lastIndex = 0;
      let text = '';
      for (const [start, end] of merged) {
        if (start > lastIndex) {
          text += line.slice(lastIndex, start);
        }
        if (cursorColumn !== null && cursorColumn !== undefined) {
          if (cursorColumn > start) {
            if (cursorColumn < end) {
              cursorColumn = start - removed;
            } else {
              cursorColumn -= (end - start);
            }
          }
        }
        removed += end - start;
        lastIndex = end;
      }
      text += line.slice(lastIndex);
      const trimmed = text.replace(/\s+$/g, '');
      if (cursorColumn !== null && cursorColumn !== undefined) {
        cursorColumn = Math.min(cursorColumn, trimmed.length);
      }
      return { text: trimmed, column: cursorColumn };
    };

    const lines = [];
    const cursorLine = buffer.baseY + buffer.cursorY;
    const cursorColumn = buffer.cursorX;
    let nextCursor = null;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const raw = line ? line.translateToString(false) : '';
      if (i === cursorLine) {
        const sanitized = sanitizeLine(raw, cursorColumn);
        lines.push(sanitized.text);
        if (sanitized.column !== null && sanitized.column !== undefined) {
          nextCursor = { line: i, column: sanitized.column };
        }
      } else {
        lines.push(sanitizeLine(raw, null).text);
      }
    }

    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] && lines[i].trimEnd() !== '') {
        lastNonEmpty = i;
        break;
      }
    }
    const lastLineIndex = Math.max(lastNonEmpty, nextCursor ? nextCursor.line : -1);
    const visibleLines = lastLineIndex >= 0 ? lines.slice(0, lastLineIndex + 1) : [];
    replaceReaderBuffer(visibleLines.join('\n'));
    setReaderLines(visibleLines);
    setReaderCursor(nextCursor);
  }, [replaceReaderBuffer]);

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

  const handleTerminalTap = useCallback((event) => {
    if (!isMobile || event?.defaultPrevented) return;
    if (viewMode === 'reader') return;
    const target = event?.target;
    if (target instanceof Element) {
      if (target.closest('button, input, textarea, select, a')) {
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
    if (!scrollModeRef.current) return;
    const term = xtermRef.current;
    if (!term) return;
    const deltaY = info?.deltaY || 0;
    if (!deltaY) return;
    if (info?.event?.cancelable) {
      info.event.preventDefault();
    }
    const lineHeight = Math.max(10, Math.round((term.options?.fontSize || 14) * 1.25));
    const lines = Math.max(1, Math.round(Math.abs(deltaY) / lineHeight));
    const scrollingUp = deltaY > 0;
    term.scrollLines(scrollingUp ? -lines : lines);
    if (scrollingUp) {
      triggerLoadMoreIfAtTop();
    }
  }, [triggerLoadMoreIfAtTop]);

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
    scrollModeRef.current = isScrollMode;
  }, [isScrollMode]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === 'reader') {
      syncReaderBuffer();
    }
  }, [viewMode, syncReaderBuffer]);

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
    shouldReplayHistoryRef.current = true;
    setIsLoadingHistory(true);
    setIsLoadingMoreHistory(false);
    historyStateRef.current = {
      maxHistoryEvents: INITIAL_HISTORY_EVENTS,
      maxHistoryChars: INITIAL_HISTORY_CHARS,
      exhausted: false,
      loading: false,
      lastCount: 0,
      lastChars: 0,
      lastLoadAt: 0
    };
    historyReloadingRef.current = false;
    pendingSocketDataRef.current = [];
  }, [sessionId]);

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

    const scrollback = performanceMode
      ? (isMobile ? SCROLLBACK_MOBILE : SCROLLBACK_DESKTOP)
      : (isMobile ? SCROLLBACK_MOBILE * 2 : SCROLLBACK_DESKTOP * 3);
    const term = new Terminal({
      cursorBlink: false,
      fontSize: fontSize || (isMobile ? 20 : 14),
      fontFamily: isMobile
        ? '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
        : 'Consolas, "Courier New", monospace',
      rendererType: 'canvas',
      scrollback,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4'
      },
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
      if (!inputBufferRef.current) return;
      const payload = inputBufferRef.current;
      inputBufferRef.current = '';
      inputFlushRef.current = null;
      sendTerminalInput(payload);
    };

    const queueTerminalInput = (data) => {
      if (!data || disposed) return;
      inputBufferRef.current += data;
      if (!inputFlushRef.current) {
        inputFlushRef.current = requestAnimationFrame(flushInputBuffer);
      }
      if (data.includes('\r')) {
        flushInputBuffer();
      }
    };

    const sendUserInput = (text) => {
      if (!text || disposed) return;
      exitCopyModeIfActive();
      markUserInput();
      queueTerminalInput(text);
    };
    sendTerminalInputRef.current = sendUserInput;
    if (registerTerminalSender) {
      registerTerminalSender(sessionId, sendUserInput);
    }

    const handleClipboardPaste = async () => {
      try {
        if (navigator.clipboard?.readText) {
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              sendUserInput(text);
              return;
            }
          } catch {
            // Continue to image handling
          }
        }

        if (navigator.clipboard?.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();
            for (const item of clipboardItems) {
              const imageType = item.types.find(t => t.startsWith('image/'));
              if (imageType) {
                const blob = await item.getType(imageType);
                const path = await uploadScreenshot(blob);
                if (path) {
                  sendUserInput(path + ' ');
                  return;
                }
              }
            }
          } catch {
            // Ignore and fall back to text below
          }
        }

        if (navigator.clipboard?.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            sendUserInput(text);
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
      if (width <= 0 || height <= 0) {
        rafId = requestAnimationFrame(openWhenReady);
        return;
      }

      hasOpened = true;
      term.open(container);

      // Enable WebGL GPU rendering for better performance (except on mobile)
      if (!isMobile) {
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
      }

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

      // Custom wheel handling to improve tmux scroll reliability
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

        event.preventDefault();
        scrollByWheel(event.deltaY, event.deltaMode, term.rows);
        if (event.deltaY < 0) {
          triggerLoadMoreIfAtTop();
        }
        return false;
      });

      // Scroll direction detection for header collapse
      let lastScrollPos = 0;
      let scrollThrottleTimer = null;
      const loadMoreHistory = async () => {
        if (disposed) return;
        const state = historyStateRef.current;
        if (state.loading || state.exhausted) return;
        const now = Date.now();
        if (now - state.lastLoadAt < 1500) return;

        const nextEvents = Math.min(state.maxHistoryEvents * 2, HISTORY_MAX_EVENTS);
        const nextChars = Math.min(state.maxHistoryChars * 2, HISTORY_MAX_CHARS);
        if (nextEvents === state.maxHistoryEvents && nextChars === state.maxHistoryChars) {
          state.exhausted = true;
          return;
        }

        state.loading = true;
        state.lastLoadAt = now;
        historyReloadingRef.current = true;
        setIsLoadingMoreHistory(true);

        try {
          const response = await apiFetch(
            `/api/terminal/${sessionId}/history?historyEvents=${nextEvents}&historyChars=${nextChars}`
          );
          if (!response.ok) {
            return;
          }
          const snapshot = await response.json();
          const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
          const totalChars = history.reduce((sum, entry) => sum + (entry?.text?.length || 0), 0);

          if (history.length <= state.lastCount && totalChars <= state.lastChars) {
            state.exhausted = true;
            return;
          }

          state.maxHistoryEvents = nextEvents;
          state.maxHistoryChars = nextChars;
          state.lastCount = history.length;
          state.lastChars = totalChars;

          const historyText = history.map((entry) => entry.text).join('');
          term.reset();
          clearReader();
          term.write(historyText, () => {
            if (disposed) return;
            if (viewModeRef.current === 'reader') {
              syncReaderBuffer();
            } else {
              appendToReader(historyText);
            }
            term.scrollToTop();
            historyReloadingRef.current = false;
            const pending = pendingSocketDataRef.current;
            pendingSocketDataRef.current = [];
            if (pending.length > 0) {
              const pendingText = pending.join('');
              if (viewModeRef.current === 'reader') {
                term.write(pendingText, scheduleReaderSync);
              } else {
                term.write(pendingText);
                appendToReader(pendingText);
              }
            }
          });
        } catch {
          // Ignore load failures; retry on next scroll-to-top.
        } finally {
          state.loading = false;
          if (historyReloadingRef.current) {
            historyReloadingRef.current = false;
            const pending = pendingSocketDataRef.current;
            pendingSocketDataRef.current = [];
            if (pending.length > 0 && !disposed) {
              const pendingText = pending.join('');
              if (viewModeRef.current === 'reader') {
                term.write(pendingText, scheduleReaderSync);
              } else {
                term.write(pendingText);
                appendToReader(pendingText);
              }
            }
          }
          setIsLoadingMoreHistory(false);
        }
      };
      loadMoreHistoryRef.current = loadMoreHistory;
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
          if (cols && rows) {
            apiFetch(`/api/terminal/${sessionId}/resize`, {
              method: 'POST',
              body: { cols, rows }
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
        }
      };
      window.addEventListener('focus', handleFocus);
      document.addEventListener('visibilitychange', handleVisibility);

      const buildSocketUrl = (requestHistory) => {
        const token = getAccessToken();
        const base = import.meta.env.VITE_API_URL || window.location.origin;
        const url = new URL(`/api/terminal/${sessionId}/ws`, base);
        if (token) url.searchParams.set('token', token);
        if (requestHistory) {
          url.searchParams.set('historyChars', String(INITIAL_HISTORY_CHARS));
          url.searchParams.set('historyEvents', String(INITIAL_HISTORY_EVENTS));
        }
        url.searchParams.set('history', requestHistory ? '1' : '0');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
      };

      let wsRetryCount = 0;
      const MAX_WS_RETRY_DELAY = 30000;

      const connectSocket = () => {
        if (disposed) return;
        const existing = socketRef.current;
        if (existing) existing.close();

        const requestHistory = shouldReplayHistoryRef.current;
        const socket = new WebSocket(buildSocketUrl(requestHistory));
        socketRef.current = socket;
        let hadConnectionError = false;
        let shouldReconnect = true;
        let skipUrlDetection = true;
        let skipUrlTimeout = null;
        let heartbeatTimer = null;
        let lastServerPingAt = 0;
        const HEARTBEAT_INTERVAL = 10000;
        const HEARTBEAT_TIMEOUT = 45000;

        socket.onopen = () => {
          if (disposed) return;
          wsRetryCount = 0;
          resetUserInput();
          onConnectionChange?.(true);
          lastServerPingAt = Date.now();
          if (requestHistory) {
            shouldReplayHistoryRef.current = false;
          }
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            if (now - lastServerPingAt > HEARTBEAT_TIMEOUT) {
              socket.close(4000, 'Heartbeat timeout');
            }
          }, HEARTBEAT_INTERVAL);
          if (hadConnectionError && requestHistory) {
            hadConnectionError = false;
            term.reset();
            clearReader();
          }
          skipUrlTimeout = setTimeout(() => {
            skipUrlDetection = false;
            setIsLoadingHistory(false);
          }, 500);
        };

        socket.onmessage = async (event) => {
          if (disposed) return;

          // Handle binary frames (ArrayBuffer or Blob) for bandwidth optimization
          let data;
          if (event.data instanceof ArrayBuffer) {
            const decoder = new TextDecoder();
            data = decoder.decode(event.data);
          } else if (event.data instanceof Blob) {
            data = await event.data.text();
          } else {
            // Text frame (fallback for backward compatibility)
            data = event.data;
          }

          lastServerPingAt = Date.now();
          if (data === '__terminal_pong__') return;
          if (data.includes('__terminal_ping__')) {
            data = data.split('__terminal_ping__').join('');
          }
          if (data.includes('{"type":"ping","source":"terminal-client"}')) {
            data = data.split('{"type":"ping","source":"terminal-client"}').join('');
          }
          if (!data) return;

          if (data.startsWith('{')) {
            try {
              const msg = JSON.parse(data);
              if (msg.type === 'clientId' && msg.clientId && isValidClientId(msg.clientId)) {
                clientIdRef.current = msg.clientId;
                const { cols, rows } = term;
                if (cols && rows) {
                  apiFetch(`/api/terminal/${sessionId}/resize`, {
                    method: 'POST',
                    body: { cols, rows, clientId: msg.clientId }
                  }).catch(() => {});
                }
                return;
              }
              if (msg.type === 'serverPing') {
                return;
              }
              if (msg.type === 'pong' && msg.source === 'terminal-client') {
                return;
              }
              if (msg.type === 'cwd' && msg.cwd) {
                onCwdChange?.(msg.cwd);
                return;
              }
            } catch { /* Not valid JSON */ }
          }

          const buffer = term.buffer?.active;
          const baseY = buffer?.baseY || 0;
          const viewportYBefore = buffer?.viewportY ?? 0;
          const wasAtBottom = buffer ? baseY === buffer.viewportY : true;

          if (historyReloadingRef.current) {
            pendingSocketDataRef.current.push(data);
            return;
          }

          if (viewModeRef.current === 'reader') {
            term.write(data, scheduleReaderSync);
          } else {
            term.write(data);
            appendToReader(data);
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
        };

        socket.onerror = () => {
          if (disposed) return;
          onConnectionChange?.(false);
          if (!hadConnectionError) {
            hadConnectionError = true;
            term.write('\r\n[Connection lost – attempting to reconnect…]\r\n');
          }
        };

        socket.onclose = (event) => {
          if (disposed) return;
          onConnectionChange?.(false);
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (event.reason === 'Session ended') {
            shouldReconnect = false;
            term.write('\r\n[Terminal session ended]\r\n');
            return;
          }
          if (shouldReconnect) {
            wsRetryCount++;
            const delay = Math.min(1000 * Math.pow(2, wsRetryCount - 1), MAX_WS_RETRY_DELAY);
            setTimeout(connectSocket, delay);
          }
        };

        return () => {
          shouldReconnect = false;
          if (skipUrlTimeout) clearTimeout(skipUrlTimeout);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          socket.close();
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
        queueTerminalInput(data);
      });

      const handleResize = () => debouncedFit();
      window.addEventListener('resize', handleResize);

      let resizeTimeout = null;
      const resizeDisposer = term.onResize(({ cols, rows }) => {
        if (disposed) return;
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (disposed) return;
          const resizeBody = { cols, rows };
          if (clientIdRef.current) resizeBody.clientId = clientIdRef.current;
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
          sendUserInput(text);
        } catch (err) {
          console.error('Failed to read clipboard:', err);
        }
      };
      container.addEventListener('contextmenu', handleContextMenu);

      const handlePasteEvent = (e) => {
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
        if (text) {
          e.preventDefault();
          e.stopPropagation();
          sendUserInput(text);
          return;
        }

        const files = Array.from(clipboardData.files || []);
        let imageFile = files.find((file) => file.type && file.type.startsWith('image/')) || null;
        if (!imageFile) {
          const items = Array.from(clipboardData.items || []);
          const imageItem = items.find((item) => item.type && item.type.startsWith('image/'));
          imageFile = imageItem ? imageItem.getAsFile() : null;
        }

        if (!imageFile) {
          handleClipboardPaste();
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        uploadScreenshot(imageFile)
          .then((path) => {
            if (path) {
              sendUserInput(path + ' ');
            }
          })
          .catch((error) => {
            console.error('Failed to paste image:', error);
          });
      };
      container.addEventListener('paste', handlePasteEvent, true);

      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('focus', handleFocus);
        document.removeEventListener('visibilitychange', handleVisibility);
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
        cancelAnimationFrame(inputFlushRef.current);
        inputFlushRef.current = null;
      }
      inputBufferRef.current = '';
      if (rafId) cancelAnimationFrame(rafId);
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
    };
  // Note: fontSize intentionally excluded - handled by separate effect below
  // Callbacks like onActivityChange, onConnectionChange, onCwdChange are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onUrlDetected, isMobile]);

  // Handle font size changes without recreating terminal
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current) return;
    const term = xtermRef.current;
    const newSize = fontSize || (isMobile ? 20 : 14);
    if (term.options.fontSize !== newSize) {
      term.options.fontSize = newSize;
      fitAddonRef.current.fit();
    }
  }, [fontSize, isMobile]);

  // Handle keybar/viewport changes with debounced fit
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);

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
    }, 150);
  }, [keybarOpen, viewportHeight]);

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
      {viewMode === 'reader' && (
        <ReaderView
          content={readerBuffer}
          lines={readerLines}
          cursor={readerCursor}
          fontSize={fontSize || (isMobile ? 20 : 14)}
          onScrollDirection={onScrollDirection}
          onLoadMore={handleReaderLoadMore}
          onInput={handleReaderInput}
          isMobile={isMobile}
        />
      )}

      {isMobile && isScrollMode && (
        <div className="terminal-scroll-mode-hint">Scroll mode — tap to type</div>
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
      <TerminalHistoryModal
        isOpen={historyModalOpen}
        sessionId={sessionId}
        onClose={() => setHistoryModalOpen(false)}
      />
    </div>
  );
}
