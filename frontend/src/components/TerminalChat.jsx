import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch, uploadScreenshot } from '../utils/api';
import { getAccessToken } from '../utils/auth';
import { useMobileDetect } from '../hooks/useMobileDetect';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize, onScrollDirection, onRegisterImageUpload }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const clientIdRef = useRef(null);
  const isMobile = useMobileDetect();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [imageDragOver, setImageDragOver] = useState(false);
  const imageInputRef = useRef(null);
  const sendTerminalInputRef = useRef(null);
  const fitTimeoutRef = useRef(null);
  const isValidClientId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

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

  // Track if we're in tmux copy mode
  const inCopyModeRef = useRef(false);
  const copyModeTimeoutRef = useRef(null);

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
    if (!inCopyModeRef.current) {
      sendToTerminal('\x02['); // Ctrl+B [ to enter copy mode
      inCopyModeRef.current = true;
    }
    // Reset timeout - assume copy-mode exited after 10s of no scroll activity
    clearTimeout(copyModeTimeoutRef.current);
    copyModeTimeoutRef.current = setTimeout(() => {
      inCopyModeRef.current = false;
    }, 10000);
  }, [sendToTerminal]);

  // Scroll in tmux copy-mode (shared logic for buttons and wheel)
  const scrollInTmux = useCallback((direction) => {
    const term = xtermRef.current;
    if (!term) return;

    const baseY = term.buffer?.active?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(direction === 'up' ? -5 : 5);
    } else {
      // No xterm scrollback - tmux managing it
      enterCopyMode();
      sendToTerminal(direction === 'up' ? '\x1b[5~' : '\x1b[6~'); // Page Up/Down
    }
  }, [sendToTerminal, enterCopyMode]);

  // Scroll handlers for mobile buttons
  const scrollUp = useCallback(() => scrollInTmux('up'), [scrollInTmux]);
  const scrollDown = useCallback(() => scrollInTmux('down'), [scrollInTmux]);

  // Start continuous scrolling with acceleration (called on press)
  const startScrolling = useCallback((direction) => {
    // Clear any existing timeout
    if (scrollIntervalRef.current) {
      clearTimeout(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }

    // Track start time and direction
    scrollStartTimeRef.current = Date.now();
    scrollDirectionRef.current = direction;

    // Scroll immediately on press
    if (direction === 'up') {
      scrollUp();
    } else {
      scrollDown();
    }

    // Acceleration settings (halved speed from original)
    const INITIAL_DELAY = 400;  // Start slow (400ms between scrolls)
    const MIN_DELAY = 60;       // Maximum speed (60ms between scrolls)
    const ACCEL_TIME = 2000;    // Time to reach max speed (2 seconds)

    // Recursive function for accelerating scroll
    const scheduleNextScroll = () => {
      const elapsed = Date.now() - scrollStartTimeRef.current;

      // Calculate current delay (linear interpolation from INITIAL to MIN over ACCEL_TIME)
      const progress = Math.min(elapsed / ACCEL_TIME, 1);
      const currentDelay = INITIAL_DELAY - (INITIAL_DELAY - MIN_DELAY) * progress;

      scrollIntervalRef.current = setTimeout(() => {
        if (scrollDirectionRef.current === 'up') {
          scrollUp();
        } else if (scrollDirectionRef.current === 'down') {
          scrollDown();
        }

        // Continue if still scrolling
        if (scrollDirectionRef.current) {
          scheduleNextScroll();
        }
      }, currentDelay);
    };

    // Start the acceleration loop
    scheduleNextScroll();
  }, [scrollUp, scrollDown]);

  // Stop continuous scrolling (called on release)
  const stopScrolling = useCallback(() => {
    scrollDirectionRef.current = null;
    scrollStartTimeRef.current = null;
    if (scrollIntervalRef.current) {
      clearTimeout(scrollIntervalRef.current);
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
      cursorBlink: true,
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
      console.log('[TerminalChat] Sending input:', text.length, 'chars');
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
      if (textarea) {
        textarea.style.position = 'fixed';
        textarea.style.top = '0';
        textarea.style.left = '-9999px';
        textarea.addEventListener('focus', handleTextareaFocus);
      }

      // Scroll direction detection for header collapse
      let lastScrollPos = 0;
      const scrollDisposer = term.onScroll((newPos) => {
        if (onScrollDirection && !disposed) {
          const direction = newPos > lastScrollPos ? 'down' : 'up';
          onScrollDirection(direction);
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
          if (hadConnectionError) {
            hadConnectionError = false;
            term.write('\r\n[Reconnected]\r\n');
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
            setTimeout(connectSocket, 1000);
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

        // Filter out terminal query RESPONSES that shouldn't be sent as input
        // These are responses like DA (Device Attributes), DSR (Device Status Report)
        // Examples: \x1b[?1;2c, \x1b[0n, \x1b[>0;0;0c
        // DO NOT filter arrow keys (\x1b[A, \x1b[B, etc.) or other user input
        const isQueryResponse = /^\x1b\[[\?>\d;]*[cn]$/.test(data) || /^\x1b\]/.test(data);
        if (isQueryResponse) {
          console.log('[TerminalChat] Filtering query response:', data.length, 'chars');
          return;
        }

        // Reset copy-mode state when user types
        // Don't send 'q' - if state is stale, it would inject 'q' into shell
        // User's input will naturally exit copy-mode if they're in it
        if (inCopyModeRef.current) {
          inCopyModeRef.current = false;
          clearTimeout(copyModeTimeoutRef.current);
        }

        console.log('[TerminalChat] onData triggered:', data.length, 'chars');
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

            // Always send copy-mode entry first
            socket.send('\x02['); // Ctrl+B [ to enter copy mode
            inCopyModeRef.current = true;

            // Send scroll after a short delay to ensure copy-mode is active
            pendingScroll = setTimeout(() => {
              if (scrollDirection === 'up') {
                socket.send('\x1b[5~'); // Page Up
              } else {
                socket.send('\x1b[6~'); // Page Down
              }
              pendingScroll = null;
            }, 50);

            // Reset timeout - assume copy-mode exited after 10s of no activity
            clearTimeout(copyModeTimeoutRef.current);
            copyModeTimeoutRef.current = setTimeout(() => {
              inCopyModeRef.current = false;
            }, 10000);
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
        }
        closeSocket?.();
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
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
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (scrollIntervalRef.current) {
        clearInterval(scrollIntervalRef.current);
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
      <div ref={terminalRef} className="xterm-container" style={{ height: '100%', width: '100%' }}></div>

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
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startScrolling('up');
            }}
            onPointerUp={stopScrolling}
            onPointerLeave={stopScrolling}
            onTouchStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startScrolling('up');
            }}
            onTouchEnd={stopScrolling}
            aria-label="Scroll up"
          >
            ▲
          </button>
          <button
            className="scroll-btn scroll-down"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startScrolling('down');
            }}
            onPointerUp={stopScrolling}
            onPointerLeave={stopScrolling}
            onTouchStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startScrolling('down');
            }}
            onTouchEnd={stopScrolling}
            aria-label="Scroll down"
          >
            ▼
          </button>
      </div>
    </div>
  );
}
