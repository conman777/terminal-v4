import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';
import { apiFetch } from '../utils/api';
import { getAccessToken } from '../utils/auth';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const socketRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());
  const suppressPasteEventRef = useRef(false);

  useEffect(() => {
    if (!sessionId || !terminalRef.current) return;

    let disposed = false;
    let hasOpened = false;
    let rafId = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4'
      },
      allowProposedApi: true
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

        socket.onopen = () => {
          if (disposed) return;
          if (hadConnectionError) {
            hadConnectionError = false;
            term.write('\r\n[Reconnected]\r\n');
          }
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          term.write(data);

          if (onUrlDetected && isServerReady(data)) {
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
          socket.close();
        };
      };

      const closeSocket = connectSocket();

      const dataDisposer = term.onData((data) => {
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
          apiFetch(`/api/terminal/${sessionId}/resize`, {
            method: 'POST',
            body: { cols, rows }
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
  }, [sessionId, onUrlDetected]);

  useEffect(() => {
    if (!fitAddonRef.current) return;
    try {
      fitAddonRef.current.fit();
    } catch (error) {
      console.error('[Terminal Fit] Failed to resize terminal:', error);
    }
  }, [keybarOpen, viewportHeight]);

  return (
    <div className="terminal-chat">
      <div ref={terminalRef} className="xterm-container" style={{ height: '100%', width: '100%' }}></div>
    </div>
  );
}
