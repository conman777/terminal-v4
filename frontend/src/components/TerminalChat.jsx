import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractPreviewUrl, isServerReady } from '../utils/urlDetector';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight, onUrlDetected }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);
  const detectedUrlsRef = useRef(new Set());

  useEffect(() => {
    if (!sessionId || !terminalRef.current) return;

    let disposed = false;
    let hasOpened = false;

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

    // Handle paste with Ctrl+V
    const handlePaste = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && !disposed) {
          // Send pasted text to the terminal backend
          fetch(`/api/terminal/${sessionId}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: text })
          }).catch((error) => {
            console.error('Failed to send pasted input:', error);
          });
        }
      } catch (err) {
        console.error('Failed to read clipboard:', err);
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      // Allow Ctrl+C to copy (don't intercept when text is selected)
      if (event.ctrlKey && event.key === 'c' && term.hasSelection()) {
        return false; // Let browser handle copy
      }

      // Handle Ctrl+V paste
      if (event.ctrlKey && event.key === 'v') {
        handlePaste();
        return false; // Prevent default handling
      }

      // Handle Ctrl+Shift+V paste (common in terminals)
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        handlePaste();
        return false;
      }

      return true; // Let terminal handle other keys
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
        requestAnimationFrame(openWhenReady);
        return;
      }

      hasOpened = true;
      term.open(container);

      requestAnimationFrame(() => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
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

      // Connect to SSE stream (which sends history first, then new events)
      const source = new EventSource(`/api/terminal/${sessionId}/stream`);
      eventSourceRef.current = source;

      source.addEventListener('data', (event) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(event.data);
          term.write(payload.text);

          // Detect URLs in terminal output
          if (onUrlDetected && isServerReady(payload.text)) {
            const url = extractPreviewUrl(payload.text);
            if (url && !detectedUrlsRef.current.has(url)) {
              detectedUrlsRef.current.add(url);
              onUrlDetected(url);
            }
          }
        } catch (err) {
          console.error('[Terminal Stream] Failed to parse event data:', err);
        }
      });

      source.addEventListener('end', () => {
        if (disposed) return;
        term.write('\r\n[Terminal session ended]\r\n');
        source.close();
      });

      source.onerror = () => {
        source.close();
      };

      const dataDisposer = term.onData((data) => {
        fetch(`/api/terminal/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: data })
        }).catch((error) => {
          console.error('Failed to send terminal input:', error);
        });
      });

      const handleResize = () => {
        if (!disposed && fitAddonRef.current) {
          fitAddonRef.current.fit();
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
          fetch(`/api/terminal/${sessionId}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols, rows })
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
          if (text && !disposed) {
            fetch(`/api/terminal/${sessionId}/input`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: text })
            }).catch((error) => {
              console.error('Failed to send pasted input:', error);
            });
          }
        } catch (err) {
          console.error('Failed to read clipboard:', err);
        }
      };

      container.addEventListener('contextmenu', handleContextMenu);

      // Ensure cleanup can remove listeners
      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
        container.removeEventListener('contextmenu', handleContextMenu);
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

    requestAnimationFrame(openWhenReady);

    return () => {
      disposed = true;
      detectedUrlsRef.current.clear();
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (openWhenReady.cleanup) {
        openWhenReady.cleanup();
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
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
