import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, onScrollDirection, onRegisterImageUpload, onRegisterFocusTerminal, onActivityChange, onConnectionChange, onCwdChange, usesTmux }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const clientIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const inputFlushRef = useRef(null);
  const isMobile = useMobileDetect();
  const { activeSessionId, sessions } = useTerminalSession();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const sendTerminalInputRef = useRef(null);
  const fitTimeoutRef = useRef(null);
  const onScrollDirectionRef = useRef(onScrollDirection);
  const usesTmuxRef = useRef(Boolean(usesTmux));
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isActiveSession = sessionId === activeSessionId;

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
    jumpToLive,
    startScrolling,
    stopScrolling,
    exitCopyModeIfActive,
    cleanup: cleanupScrolling
  } = useTerminalScrolling(xtermRef, sendToTerminal);

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

  const handleTerminalTap = useCallback((event) => {
    if (!isMobile || event?.defaultPrevented) return;
    const target = event?.target;
    if (target instanceof Element) {
      if (target.closest('button, input, textarea, select, a')) {
        return;
      }
    }
    setMobileInputEnabled(true);
  }, [isMobile, setMobileInputEnabled]);

  // Touch gesture handling
  const {
    touchStateRef,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleTouchCancelCapture
  } = useTouchGestures(isMobile, handleTerminalTap);

  // Keep ref updated to avoid stale closures
  useEffect(() => {
    onScrollDirectionRef.current = onScrollDirection;
  }, [onScrollDirection]);

  useEffect(() => {
    usesTmuxRef.current = Boolean(usesTmux);
  }, [usesTmux]);

  // Reset loading state when session changes
  useEffect(() => {
    setIsLoadingHistory(true);
  }, [sessionId]);

  // Register image upload trigger for external components
  useEffect(() => {
    if (onRegisterImageUpload) {
      onRegisterImageUpload(triggerFileInput);
    }
  }, [onRegisterImageUpload, triggerFileInput]);

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

    const term = new Terminal({
      cursorBlink: false,
      fontSize: fontSize || (isMobile ? 20 : 14),
      fontFamily: isMobile
        ? '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
        : 'Consolas, "Courier New", monospace',
      rendererType: 'canvas',
      scrollback: 5000,
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
    sendTerminalInputRef.current = sendTerminalInput;

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

    const handleClipboardPaste = async () => {
      try {
        if (navigator.clipboard.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();
            for (const item of clipboardItems) {
              const imageType = item.types.find(t => t.startsWith('image/'));
              if (imageType) {
                const blob = await item.getType(imageType);
                const path = await uploadScreenshot(blob);
                if (path) {
                  sendTerminalInput(path + ' ');
                  return;
                }
              }
            }
          } catch {
            // Fallback to text
          }
        }
        const text = await navigator.clipboard.readText();
        sendTerminalInput(text);
      } catch (err) {
        console.error('Failed to read clipboard:', err);
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.key === 'c' && term.hasSelection()) {
        return false;
      }
      if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
        suppressPasteEventRef.current = true;
        setTimeout(() => { suppressPasteEventRef.current = false; }, 0);
        handleClipboardPaste();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        suppressPasteEventRef.current = true;
        setTimeout(() => { suppressPasteEventRef.current = false; }, 0);
        handleClipboardPaste();
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

      // Custom wheel handling to avoid arrow-key fallback when tmux has no scrollback
      let wheelAccumulator = 0;
      let lastWheelDirection = 0;
      const SCROLL_THRESHOLD = 80;
      const LINE_HEIGHT = 16;

      term.attachCustomWheelEventHandler((event) => {
        if (!usesTmuxRef.current) {
          return true;
        }

        const mouseTrackingMode = term.modes?.mouseTrackingMode;
        if (mouseTrackingMode && mouseTrackingMode !== 'none') {
          return true;
        }

        const buffer = term.buffer?.active;
        const baseY = buffer?.baseY || 0;
        if (baseY > 0) {
          return true;
        }

        if (event.deltaY === 0) {
          return true;
        }

        event.preventDefault();

        let delta = event.deltaY;
        if (event.deltaMode === 1) {
          delta *= LINE_HEIGHT;
        } else if (event.deltaMode === 2) {
          delta *= LINE_HEIGHT * term.rows;
        }

        const currentDirection = Math.sign(delta);
        if (currentDirection !== 0 && currentDirection !== lastWheelDirection) {
          wheelAccumulator = 0;
          lastWheelDirection = currentDirection;
        }

        wheelAccumulator += delta;

        if (Math.abs(wheelAccumulator) >= SCROLL_THRESHOLD) {
          wheelAccumulator = 0;
          if (currentDirection < 0) {
            scrollUp();
          } else if (currentDirection > 0) {
            scrollDown();
          }
        }

        return false;
      });

      // Scroll direction detection for header collapse
      let lastScrollPos = 0;
      let scrollThrottleTimer = null;
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

      const buildSocketUrl = () => {
        const token = getAccessToken();
        const base = import.meta.env.VITE_API_URL || window.location.origin;
        const url = new URL(`/api/terminal/${sessionId}/ws`, base);
        if (token) url.searchParams.set('token', token);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
      };

      let wsRetryCount = 0;
      const MAX_WS_RETRY_DELAY = 30000;

      const connectSocket = () => {
        if (disposed) return;
        const existing = socketRef.current;
        if (existing) existing.close();

        const socket = new WebSocket(buildSocketUrl());
        socketRef.current = socket;
        let hadConnectionError = false;
        let shouldReconnect = true;
        let skipUrlDetection = true;
        let skipUrlTimeout = null;

        socket.onopen = () => {
          if (disposed) return;
          wsRetryCount = 0;
          resetUserInput();
          onConnectionChange?.(true);
          if (hadConnectionError) {
            hadConnectionError = false;
            term.reset();
          }
          skipUrlTimeout = setTimeout(() => {
            skipUrlDetection = false;
            setIsLoadingHistory(false);
          }, 500);
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          let data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);

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

          term.write(data);

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
          sendTerminalInput(text);
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
        e.preventDefault();
        e.stopPropagation();
        const text = e.clipboardData?.getData('text');
        if (text) {
          sendTerminalInput(text);
          return;
        }
        handleClipboardPaste();
      };
      container.addEventListener('paste', handlePasteEvent, true);

      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
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
      };
    };

    rafId = requestAnimationFrame(openWhenReady);

    return () => {
      disposed = true;
      detectedUrlsRef.current.clear();
      clientIdRef.current = null;
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
      className="terminal-chat"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleImageDrop}
      onClick={handleTerminalTap}
      onTouchStartCapture={handleTouchStartCapture}
      onTouchMoveCapture={handleTouchMoveCapture}
      onTouchEndCapture={handleTouchEndCapture}
      onTouchCancelCapture={handleTouchCancelCapture}
    >
      <div ref={terminalRef} className="xterm-container"></div>

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
      <div className={`terminal-scroll-buttons ${isMobile ? 'mobile' : 'desktop'}`}>
          <button
            className="scroll-btn scroll-up"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); scrollUp(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); startScrolling('up'); }}
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
    </div>
  );
}
