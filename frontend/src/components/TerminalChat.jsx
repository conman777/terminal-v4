import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch, uploadScreenshot } from '../utils/api';
import { getAccessToken } from '../utils/auth';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { useTerminalSession } from '../contexts/TerminalSessionContext';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, onScrollDirection, onRegisterImageUpload, onActivityChange }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const clientIdRef = useRef(null);
  const isMobile = useMobileDetect();
  const { activeSessionId, sessions } = useTerminalSession();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const imageInputRef = useRef(null);
  const sendTerminalInputRef = useRef(null);
  const fitTimeoutRef = useRef(null);
  const idleTimerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const faviconIntervalRef = useRef(null);
  const onScrollDirectionRef = useRef(onScrollDirection);
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const isActiveSession = sessionId === activeSessionId;

  // Keep ref updated to avoid stale closures
  useEffect(() => {
    onScrollDirectionRef.current = onScrollDirection;
  }, [onScrollDirection]);

  // Reset loading state when session changes
  useEffect(() => {
    setIsLoadingHistory(true);
  }, [sessionId]);

  // Register image upload trigger for external components (like mobile status bar)
  useEffect(() => {
    if (onRegisterImageUpload) {
      onRegisterImageUpload(() => imageInputRef.current?.click());
    }
  }, [onRegisterImageUpload]);

  // Update document.title with active session name
  useEffect(() => {
    if (!isActiveSession) return;
    const session = sessions.find(s => s.id === sessionId);
    document.title = session?.title || 'Terminal';
  }, [isActiveSession, sessionId, sessions]);

  // Flash favicon while terminal is active
  useEffect(() => {
    if (!isActiveSession) return;

    if (isActive) {
      // Flash between active/idle favicons
      const link = document.querySelector("link[rel='icon']");
      if (!link) return;

      let showActive = true;
      faviconIntervalRef.current = setInterval(() => {
        link.href = showActive ? '/favicon-active.svg' : '/favicon-idle.svg';
        showActive = !showActive;
      }, 500);

      return () => {
        if (faviconIntervalRef.current) {
          clearInterval(faviconIntervalRef.current);
          faviconIntervalRef.current = null;
        }
      };
    } else {
      // Set solid idle favicon
      const link = document.querySelector("link[rel='icon']");
      if (link) {
        link.href = '/favicon-idle.svg';
      }
    }
  }, [isActiveSession, isActive]);

  // Track if we're in tmux copy mode
  const inCopyModeRef = useRef(false);
  const copyModeTimeoutRef = useRef(null);

  // Track if user is actively scrolling (to suppress idle sound)
  const isScrollingRef = useRef(false);
  const scrollCooldownRef = useRef(null);

  // Track if user has typed anything (only play idle sound after user input)
  const hasUserInputRef = useRef(false);

  // Track scroll interval for press-and-hold continuous scrolling
  const scrollIntervalRef = useRef(null);
  const scrollStartTimeRef = useRef(null);
  const scrollDirectionRef = useRef(null);

  // Send data to terminal via WebSocket
  const sendToTerminal = useCallback((data) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }, []);

  // Enter tmux copy-mode with automatic timeout reset
  const enterCopyMode = useCallback(() => {
    // Send tmux prefix (Ctrl+B) first, then copy-mode command ([) after brief delay
    // This ensures tmux recognizes the prefix before receiving the command
    sendToTerminal('\x02'); // Ctrl+B (tmux prefix)
    setTimeout(() => {
      sendToTerminal('['); // copy-mode command
    }, 10);
    inCopyModeRef.current = true;

    // Auto-exit copy-mode after 3s of no scroll activity
    clearTimeout(copyModeTimeoutRef.current);
    copyModeTimeoutRef.current = setTimeout(() => {
      // Actually exit tmux copy-mode by sending 'q'
      sendToTerminal('q');
      inCopyModeRef.current = false;
    }, 3000);
  }, [sendToTerminal]);

  // Scroll in tmux copy-mode (shared logic for buttons and wheel)
  const scrollInTmux = useCallback((direction) => {
    const term = xtermRef.current;
    if (!term) return;

    // Mark scrolling active to suppress idle sound
    isScrollingRef.current = true;
    if (scrollCooldownRef.current) {
      clearTimeout(scrollCooldownRef.current);
    }
    scrollCooldownRef.current = setTimeout(() => {
      isScrollingRef.current = false;
    }, 500);

    const baseY = term.buffer?.active?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(direction === 'up' ? -5 : 5);
    } else {
      // No xterm scrollback - tmux managing it
      enterCopyMode();
      // Send scroll after delay to ensure copy-mode is active
      // Use Ctrl+U/Ctrl+D for half-page scroll in tmux copy-mode (vi bindings)
      setTimeout(() => {
        sendToTerminal(direction === 'up' ? '\x15' : '\x04'); // Ctrl+U / Ctrl+D
      }, 60);
    }
  }, [sendToTerminal, enterCopyMode]);

  // Scroll handlers for mobile buttons
  const scrollUp = useCallback(() => scrollInTmux('up'), [scrollInTmux]);
  const scrollDown = useCallback(() => scrollInTmux('down'), [scrollInTmux]);

  // Jump to live output - exits tmux copy-mode and scrolls xterm to bottom
  const jumpToLive = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Exit tmux copy-mode by sending 'q' (quit copy-mode)
    // First send ESC to cancel any pending operation, then 'q' to exit
    sendToTerminal('\x1b'); // ESC
    sendToTerminal('q');    // quit copy-mode
    inCopyModeRef.current = false;
    clearTimeout(copyModeTimeoutRef.current);

    // Also scroll xterm to bottom in case it has its own scrollback
    term.scrollToBottom();
  }, [sendToTerminal]);

  // Track last scroll time for acceleration
  const lastScrollTimeRef = useRef(0);

  // Start continuous scrolling with acceleration using requestAnimationFrame
  const startScrolling = useCallback((direction) => {
    // Cancel any existing animation
    if (scrollIntervalRef.current) {
      cancelAnimationFrame(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }

    // Track start time and direction
    const startTime = Date.now();
    scrollStartTimeRef.current = startTime;
    scrollDirectionRef.current = direction;
    lastScrollTimeRef.current = 0;

    // Scroll immediately on press
    if (direction === 'up') {
      scrollUp();
    } else {
      scrollDown();
    }

    // Acceleration settings
    const INITIAL_DELAY = 400;  // Start slow (400ms between scrolls)
    const MIN_DELAY = 60;       // Maximum speed (60ms between scrolls)
    const ACCEL_TIME = 2000;    // Time to reach max speed (2 seconds)

    // Animation loop using requestAnimationFrame
    const animate = (timestamp) => {
      if (!scrollDirectionRef.current) return;

      const elapsed = Date.now() - startTime;

      // Calculate current delay based on acceleration
      const progress = Math.min(elapsed / ACCEL_TIME, 1);
      const currentDelay = INITIAL_DELAY - (INITIAL_DELAY - MIN_DELAY) * progress;

      // Check if enough time has passed since last scroll
      if (elapsed - lastScrollTimeRef.current >= currentDelay) {
        lastScrollTimeRef.current = elapsed;
        if (scrollDirectionRef.current === 'up') {
          scrollUp();
        } else if (scrollDirectionRef.current === 'down') {
          scrollDown();
        }
      }

      // Continue animation if still scrolling
      if (scrollDirectionRef.current) {
        scrollIntervalRef.current = requestAnimationFrame(animate);
      }
    };

    // Start the animation loop
    scrollIntervalRef.current = requestAnimationFrame(animate);
  }, [scrollUp, scrollDown]);

  // Stop continuous scrolling (called on release)
  const stopScrolling = useCallback(() => {
    scrollDirectionRef.current = null;
    scrollStartTimeRef.current = null;
    if (scrollIntervalRef.current) {
      cancelAnimationFrame(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Handle image upload and insert path into terminal
  const handleImageUpload = useCallback(async (file) => {
    if (!file) return;
    try {
      const path = await uploadScreenshot(file);
      if (path && sendTerminalInputRef.current) {
        sendTerminalInputRef.current(path + ' ');
      }
    } catch (err) {
      console.error('[TerminalChat] Screenshot upload failed:', err);
    }
  }, []);

  // Handle image drop
  const handleImageDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);

    const files = Array.from(e.dataTransfer?.files || []);
    const imageFile = files.find(f => f.type.startsWith('image/'));
    if (imageFile) {
      handleImageUpload(imageFile);
    }
  }, [handleImageUpload]);

  // Handle drag events
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types?.includes('Files')) {
      setImageDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);
  }, []);

  // Handle file input selection
  const handleImageSelect = useCallback((e) => {
    const file = e.target?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      handleImageUpload(file);
    }
    // Reset input so same file can be selected again
    if (e.target) e.target.value = '';
  }, [handleImageUpload]);

  useEffect(() => {
    if (!sessionId || !terminalRef.current) return;

    let disposed = false;
    let hasOpened = false;
    let rafId = null;

    const term = new Terminal({
      cursorBlink: false, // Disabled - causes constant 500ms repaints
      fontSize: fontSize || (isMobile ? 20 : 14),
      fontFamily: isMobile
        ? '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
        : 'Consolas, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4'
      },
      allowProposedApi: true,
      windowOptions: {
        setWinSizePixels: false,
        raiseWin: false,
        lowerWin: false,
        refreshWin: false,
        restoreWin: false,
        minimizeWin: false,
        setWinPosition: false,
        setWinSizeChars: false,
        fullscreenWin: false,
        maximizeWin: false,
        getWinState: false,
        getWinPosition: false,
        getWinSizePixels: false,
        getScreenSizePixels: false,
        getCellSizePixels: false,
        getWinSizeChars: false,
        getScreenSizeChars: false,
        getIconTitle: false,
        getWinTitle: false,
        pushTitle: false,
        popTitle: false,
        setWinLines: false
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
    // Store in ref so image upload callbacks can access it
    sendTerminalInputRef.current = sendTerminalInput;

    const handleClipboardPaste = async () => {
      try {
        // Try to read clipboard items (for images)
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
            // Fallback to text if clipboard.read() fails or no image
          }
        }
        // Fall back to text paste
        const text = await navigator.clipboard.readText();
        sendTerminalInput(text);
      } catch (err) {
        console.error('Failed to read clipboard:', err);
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      // Allow Ctrl+C to copy (don't intercept when text is selected)
      if (event.ctrlKey && event.key === 'c' && term.hasSelection()) {
        return false; // Let browser handle copy
      }
      // Handle Ctrl+V paste manually (xterm doesn't handle it natively)
      if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
        suppressPasteEventRef.current = true;
        setTimeout(() => {
          suppressPasteEventRef.current = false;
        }, 0);
        handleClipboardPaste();
        return false; // Prevent xterm from sending ^V
      }
      // Handle Ctrl+Shift+V paste
      if (event.ctrlKey && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        suppressPasteEventRef.current = true;
        setTimeout(() => {
          suppressPasteEventRef.current = false;
        }, 0);
        handleClipboardPaste();
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // ResizeObserver to handle container size changes (e.g., preview panel toggle)
    let resizeObserver = null;

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
      const handleTextareaFocus = () => {
        term.scrollToBottom();
      };

      // Track composition state for iOS voice dictation fix
      let isComposing = false;
      const handleCompositionStart = () => {
        isComposing = true;
      };
      const handleCompositionEnd = () => {
        isComposing = false;
      };
      // Expose composition state for onData handler
      term._isComposing = () => isComposing;

      if (textarea) {
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        textarea.addEventListener('focus', handleTextareaFocus);
        textarea.addEventListener('compositionstart', handleCompositionStart);
        textarea.addEventListener('compositionend', handleCompositionEnd);
      }

      // Scroll direction detection for header collapse (throttled to max 10 calls/sec)
      let lastScrollPos = 0;
      let scrollThrottleTimer = null;
      const scrollDisposer = term.onScroll((newPos) => {
        if (onScrollDirectionRef.current && !disposed) {
          const direction = newPos > lastScrollPos ? 'down' : 'up';
          // Throttle callback to prevent excessive state updates
          if (!scrollThrottleTimer) {
            onScrollDirectionRef.current(direction);
            scrollThrottleTimer = setTimeout(() => {
              scrollThrottleTimer = null;
            }, 100);
          }
        }
        lastScrollPos = newPos;
      });

      rafId = requestAnimationFrame(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
          // Send initial resize to backend
          const { cols, rows } = term;
          if (cols && rows) {
            apiFetch(`/api/terminal/${sessionId}/resize`, {
              method: 'POST',
              body: { cols, rows }
            }).catch(() => {});
          }
        }
      });

      // Centralized debounced fit function - prevents flashing from multiple rapid fit calls
      const debouncedFit = () => {
        if (disposed) return;
        if (fitTimeoutRef.current) {
          clearTimeout(fitTimeoutRef.current);
        }
        fitTimeoutRef.current = setTimeout(() => {
          if (disposed || !fitAddonRef.current || !xtermRef.current) return;
          try {
            // Capture scroll position BEFORE fit
            const buffer = xtermRef.current.buffer?.active;
            const wasAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;

            fitAddonRef.current.fit();

            // Only scroll to bottom if user was already there
            if (wasAtBottom) {
              xtermRef.current.scrollToBottom();
            }
          } catch (error) {
            // Ignore errors during rapid resizing
          }
        }, 150);
      };

      // Set up ResizeObserver for container size changes
      resizeObserver = new ResizeObserver(() => {
        debouncedFit();
      });
      resizeObserver.observe(container);

      const buildSocketUrl = () => {
        const token = getAccessToken();
        const base = import.meta.env.VITE_API_URL || window.location.origin;
        const url = new URL(`/api/terminal/${sessionId}/ws`, base);
        if (token) {
          url.searchParams.set('token', token);
        }
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
      };

      // Play a tone when terminal becomes idle (command finished)
      const playIdleTone = () => {
        try {
          if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
          }
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') {
            ctx.resume();
          }
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 600;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0.15, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.15);
        } catch (err) {
          // Audio not supported or blocked
        }
      };

      let wsRetryCount = 0;
      const MAX_WS_RETRY_DELAY = 30000;

      const connectSocket = () => {
        if (disposed) return;
        const existing = socketRef.current;
        if (existing) {
          existing.close();
        }

        const socket = new WebSocket(buildSocketUrl());
        socketRef.current = socket;
        let hadConnectionError = false;
        let shouldReconnect = true;
        // Skip URL detection during initial history replay (first 500ms after connect)
        let skipUrlDetection = true;
        let skipUrlTimeout = null;

        socket.onopen = () => {
          if (disposed) return;
          wsRetryCount = 0; // Reset retry count on successful connection
          // Reset user input flag - don't play idle sound until user types again
          hasUserInputRef.current = false;
          if (hadConnectionError) {
            hadConnectionError = false;
            // Clear terminal before history replay to avoid duplicates
            term.reset();
          }
          // Enable URL detection after history replay settles
          skipUrlTimeout = setTimeout(() => {
            skipUrlDetection = false;
            setIsLoadingHistory(false);
          }, 500);
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);

          // Check if this is a clientId message from the server
          if (data.startsWith('{')) {
            try {
              const msg = JSON.parse(data);
              if (msg.type === 'clientId' && msg.clientId && isValidClientId(msg.clientId)) {
                clientIdRef.current = msg.clientId;
                // Send initial dimensions with clientId now that we have it
                const { cols, rows } = term;
                if (cols && rows) {
                  apiFetch(`/api/terminal/${sessionId}/resize`, {
                    method: 'POST',
                    body: { cols, rows, clientId: msg.clientId }
                  }).catch(() => {});
                }
              }
            } catch {
              // Not JSON, write to terminal
            }
          }

          term.write(data);

          // Reset idle timer - play tone after 3s of no output
          // Only after user has typed something (not on initial history load)
          // Skip when scrolling (generates output but isn't a command finishing)
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
          }
          if (!skipUrlDetection && !isScrollingRef.current && hasUserInputRef.current) {
            setIsActive(true);
            onActivityChange?.(true);
            idleTimerRef.current = setTimeout(() => {
              playIdleTone();
              setIsActive(false);
              onActivityChange?.(false);
            }, 3000);
          }

          // Only detect URLs after initial history replay (skipUrlDetection = false)
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
          if (!hadConnectionError) {
            hadConnectionError = true;
            term.write('\r\n[Connection lost – attempting to reconnect…]\r\n');
          }
        };

        socket.onclose = (event) => {
          if (disposed) return;
          if (event.reason === 'Session ended') {
            shouldReconnect = false;
            term.write('\r\n[Terminal session ended]\r\n');
            return;
          }
          if (shouldReconnect) {
            wsRetryCount++;
            // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s max
            const delay = Math.min(1000 * Math.pow(2, wsRetryCount - 1), MAX_WS_RETRY_DELAY);
            setTimeout(connectSocket, delay);
          }
        };

        return () => {
          shouldReconnect = false;
          if (skipUrlTimeout) {
            clearTimeout(skipUrlTimeout);
          }
          socket.close();
        };
      };

      const closeSocket = connectSocket();

      const dataDisposer = term.onData((data) => {
        if (disposed) return;

        // Skip input during composition (iOS voice dictation fix)
        // This prevents duplicate text when using voice-to-text
        if (term._isComposing && term._isComposing()) {
          return;
        }

        // Filter out terminal query RESPONSES that shouldn't be sent as input
        // These are responses like DA (Device Attributes), DSR (Device Status Report)
        // Examples: \x1b[?1;2c, \x1b[0n, \x1b[>0;0;0c
        // DO NOT filter arrow keys (\x1b[A, \x1b[B, etc.) or other user input
        const isQueryResponse = /^\x1b\[[\?>\d;]*[cn]$/.test(data) || /^\x1b\]/.test(data);
        if (isQueryResponse) {
          return;
        }

        // Exit copy-mode before sending user input
        // Send ESC twice: first cancels pending operation (e.g., "Jump to forward:"),
        // second exits copy-mode. ESC is safe in most contexts (shell, vim, etc.)
        if (inCopyModeRef.current) {
          sendTerminalInput('\x1b\x1b'); // Double ESC to fully exit copy-mode
          inCopyModeRef.current = false;
          clearTimeout(copyModeTimeoutRef.current);
        }

        // Mark that user has typed - enables idle sound
        hasUserInputRef.current = true;

        sendTerminalInput(data);
      });

      // Window/viewport resize just triggers the debounced fit
      const handleResize = () => debouncedFit();

      window.addEventListener('resize', handleResize);

      // Send resize to backend PTY when terminal dimensions change (debounced)
      let resizeTimeout = null;
      const resizeDisposer = term.onResize(({ cols, rows }) => {
        if (disposed) return;
        // Debounce resize API calls to prevent ERR_INSUFFICIENT_RESOURCES
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
          if (disposed) return;
          // Include clientId so backend can track dimensions per client
          const resizeBody = { cols, rows };
          if (clientIdRef.current) {
            resizeBody.clientId = clientIdRef.current;
          }
          apiFetch(`/api/terminal/${sessionId}/resize`, {
            method: 'POST',
            body: resizeBody
          }).catch((error) => {
            console.error('Failed to send resize:', error);
          });
        }, 100);
      });

      const viewport = window.visualViewport;
      if (viewport) {
        viewport.addEventListener('resize', handleResize);
      }

      // Handle right-click paste
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

      // Mouse wheel scrolling for tmux - enter copy-mode and scroll
      let scrollAccumulator = 0;
      let lastScrollDirection = 0;
      let pendingScroll = null;
      const SCROLL_THRESHOLD = 150; // Accumulate scroll before sending page command

      const wheelHandler = (e) => {
        const buffer = term.buffer?.active;
        const baseY = buffer?.baseY || 0;
        // Only intercept if xterm has no scrollback (tmux managing it)
        if (baseY === 0) {
          e.preventDefault();
          const socket = socketRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) return;

          // Reset accumulator on direction change
          const currentDirection = Math.sign(e.deltaY);
          if (currentDirection !== 0 && currentDirection !== lastScrollDirection) {
            scrollAccumulator = 0;
            lastScrollDirection = currentDirection;
          }

          // Accumulate scroll delta
          scrollAccumulator += e.deltaY;

          // Only send scroll command when accumulated enough
          if (Math.abs(scrollAccumulator) >= SCROLL_THRESHOLD) {
            const scrollDirection = scrollAccumulator < 0 ? 'up' : 'down';
            scrollAccumulator = 0;

            // Clear any pending scroll
            if (pendingScroll) clearTimeout(pendingScroll);

            // Send ESC first to cancel any pending copy-mode operation
            // (e.g., "Jump to forward:" waiting for input)
            socket.send('\x1b'); // ESC cancels pending operations

            // Then send copy-mode entry
            socket.send('\x02['); // Ctrl+B [ to enter copy mode
            inCopyModeRef.current = true;

            // Send scroll after a short delay to ensure copy-mode is active
            // Use Ctrl+U/Ctrl+D for half-page scroll in tmux copy-mode (vi bindings)
            pendingScroll = setTimeout(() => {
              if (scrollDirection === 'up') {
                socket.send('\x15'); // Ctrl+U (scroll up half page)
              } else {
                socket.send('\x04'); // Ctrl+D (scroll down half page)
              }
              pendingScroll = null;
            }, 50);

            // Auto-exit copy-mode after 3s of no activity
            clearTimeout(copyModeTimeoutRef.current);
            copyModeTimeoutRef.current = setTimeout(() => {
              // Actually exit tmux copy-mode by sending 'q'
              if (socket.readyState === WebSocket.OPEN) {
                socket.send('q');
              }
              inCopyModeRef.current = false;
            }, 3000);
          }
        }
      };
      container.addEventListener('wheel', wheelHandler, { passive: false });

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

      // Ensure cleanup can remove listeners
      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
        container.removeEventListener('contextmenu', handleContextMenu);
        container.removeEventListener('wheel', wheelHandler);
        container.removeEventListener('paste', handlePasteEvent, true);
        if (textarea) {
          textarea.removeEventListener('focus', handleTextareaFocus);
          textarea.removeEventListener('compositionstart', handleCompositionStart);
          textarea.removeEventListener('compositionend', handleCompositionEnd);
        }
        closeSocket?.();
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
        scrollDisposer?.dispose();
        resizeDisposer?.dispose();
        dataDisposer?.dispose();
        if (viewport) {
          viewport.removeEventListener('resize', handleResize);
        }
      };
    };

    rafId = requestAnimationFrame(openWhenReady);

    return () => {
      disposed = true;
      detectedUrlsRef.current.clear();
      clientIdRef.current = null;
      hasUserInputRef.current = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (scrollCooldownRef.current) {
        clearTimeout(scrollCooldownRef.current);
        scrollCooldownRef.current = null;
      }
      if (scrollIntervalRef.current) {
        cancelAnimationFrame(scrollIntervalRef.current);
        scrollIntervalRef.current = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (openWhenReady.cleanup) {
        openWhenReady.cleanup();
      }
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
  }, [sessionId, onUrlDetected, fontSize, isMobile]);

  // Handle keybar/viewport changes with debounced fit (avoids triple-fit flashing)
  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    // Clear any pending fit and schedule a new one
    if (fitTimeoutRef.current) {
      clearTimeout(fitTimeoutRef.current);
    }

    fitTimeoutRef.current = setTimeout(() => {
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
        console.error('[Terminal Fit] Failed to resize terminal:', error);
      }
    }, 150);
  }, [keybarOpen, viewportHeight]);

  return (
    <div
      className="terminal-chat"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleImageDrop}
    >
      <div ref={terminalRef} className="xterm-container"></div>

      {/* Image upload button */}
      <button
        className="terminal-image-btn"
        onClick={() => imageInputRef.current?.click()}
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

      {/* Drop zone overlay */}
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
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              scrollUp();
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
              startScrolling('up');
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              stopScrolling();
            }}
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
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              scrollDown();
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
              startScrolling('down');
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              stopScrolling();
            }}
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
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              jumpToLive();
            }}
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
