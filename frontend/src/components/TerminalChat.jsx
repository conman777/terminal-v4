import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch } from '../utils/api';
import { getAccessToken } from '../utils/auth';
import { useMobileDetect } from '../hooks/useMobileDetect';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected, fontSize }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);
  const clientIdRef = useRef(null);
  const isMobile = useMobileDetect();

  // Track if we're in tmux copy mode
  const inCopyModeRef = useRef(false);

  // Send data to terminal via WebSocket
  const sendToTerminal = useCallback((data) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }, []);

  // Scroll handlers for mobile buttons
  // Uses tmux copy-mode when xterm has no scrollback (baseY === 0)
  const scrollUp = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    const buffer = term.buffer?.active;
    const baseY = buffer?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(-5);
    } else {
      // No xterm scrollback - likely tmux managing it
      // Enter copy mode (Ctrl+B [) then Page Up
      if (!inCopyModeRef.current) {
        sendToTerminal('\x02['); // Ctrl+B [
        inCopyModeRef.current = true;
      }
      sendToTerminal('\x1b[5~'); // Page Up
    }
  }, [sendToTerminal]);

  const scrollDown = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    const buffer = term.buffer?.active;
    const baseY = buffer?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(5);
    } else {
      // No xterm scrollback - likely tmux managing it
      // Enter copy mode (Ctrl+B [) then Page Down
      if (!inCopyModeRef.current) {
        sendToTerminal('\x02['); // Ctrl+B [
        inCopyModeRef.current = true;
      }
      sendToTerminal('\x1b[6~'); // Page Down
    }
  }, [sendToTerminal]);

  // Exit tmux copy mode when user types
  const exitCopyMode = useCallback(() => {
    if (inCopyModeRef.current) {
      sendToTerminal('q'); // Exit copy mode
      inCopyModeRef.current = false;
    }
  }, [sendToTerminal]);

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

    const handleClipboardPaste = async () => {
      try {
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

      // Set up ResizeObserver for container size changes
      resizeObserver = new ResizeObserver(() => {
        if (!disposed && fitAddonRef.current) {
          // Debounce the fit call slightly to avoid excessive calls
          requestAnimationFrame(() => {
            if (!disposed && fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
              } catch (error) {
                // Ignore errors during rapid resizing
              }
            }
          });
        }
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
          }, 500);
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);

          // Check if this is a clientId message from the server
          if (data.startsWith('{"type":"clientId"')) {
            try {
              const msg = JSON.parse(data);
              if (msg.type === 'clientId' && msg.clientId) {
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
              term.write(data);
            }
            return;
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

        // Filter out terminal escape sequences that shouldn't be sent as input
        // These are responses to terminal queries (DA, DSR, etc.), not user input
        // Filter ANY sequence starting with ESC or containing only escape codes
        const isEscapeSequence = /^\x1b/.test(data) || /^\[[\?>]\d+/.test(data);
        if (isEscapeSequence) {
          console.log('[TerminalChat] Filtering escape sequence:', data.length, 'chars');
          return;
        }

        // Exit tmux copy mode when user types
        if (inCopyModeRef.current) {
          sendTerminalInput('q'); // Exit copy mode first
          inCopyModeRef.current = false;
        }

        console.log('[TerminalChat] onData triggered:', data.length, 'chars');
        sendTerminalInput(data);
      });

      const handleResize = () => {
        if (!disposed && fitAddonRef.current) {
          const buffer = term.buffer?.active;
          const isAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
          const isFocused = term.textarea && document.activeElement === term.textarea;
          fitAddonRef.current.fit();
          if (isAtBottom || isFocused) {
            term.scrollToBottom();
          }
        }
      };

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

  useEffect(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;

    // Use requestAnimationFrame to ensure DOM has updated, then fit
    let rafId = null;
    let timerId = null;
    let timerId2 = null;

    const performFit = () => {
      try {
        const term = xtermRef.current;
        const buffer = term?.buffer?.active;
        const isAtBottom = buffer ? buffer.baseY === buffer.viewportY : true;
        const isFocused = term?.textarea && document.activeElement === term.textarea;

        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
        if (term && (isAtBottom || isFocused)) {
          term.scrollToBottom();
        }
      } catch (error) {
        console.error('[Terminal Fit] Failed to resize terminal:', error);
      }
    };

    // First fit after RAF to catch immediate layout changes
    rafId = requestAnimationFrame(() => {
      performFit();
      // Second fit after short delay to catch CSS transition/animation updates
      timerId = setTimeout(performFit, 100);
      // Third fit after longer delay for slower devices/keyboards
      timerId2 = setTimeout(performFit, 300);
    });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId) clearTimeout(timerId);
      if (timerId2) clearTimeout(timerId2);
    };
  }, [keybarOpen, viewportHeight]);

  return (
    <div className="terminal-chat">
      <div ref={terminalRef} className="xterm-container" style={{ height: '100%', width: '100%' }}></div>
      {isMobile && (
        <div className="terminal-scroll-buttons">
          <button
            className="scroll-btn scroll-up"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              scrollUp();
            }}
            aria-label="Scroll up"
          >
            ▲
          </button>
          <button
            className="scroll-btn scroll-down"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              scrollDown();
            }}
            aria-label="Scroll down"
          >
            ▼
          </button>
        </div>
      )}
    </div>
  );
}
