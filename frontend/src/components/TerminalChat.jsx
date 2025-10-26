import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function TerminalChat({ sessionId, keybarOpen, viewportHeight }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);

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
      }
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

      // Load history once the terminal is attached
      (async () => {
        try {
          const response = await fetch(`/api/terminal/${sessionId}/history`);
          if (disposed || !response.ok) return;
          const data = await response.json();
          data.history.forEach((entry) => {
            term.write(entry.text);
          });
        } catch (error) {
          console.error('[Terminal History] Failed to load history:', error);
        }
      })();

      // Connect to SSE stream
      const source = new EventSource(`/api/terminal/${sessionId}/stream`);
      eventSourceRef.current = source;

      source.addEventListener('data', (event) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(event.data);
          term.write(payload.text);
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

      const resizeDisposer = term.onResize(() => {
        handleResize();
      });

      const viewport = window.visualViewport;
      if (viewport) {
        viewport.addEventListener('resize', handleResize);
      }

      // Ensure cleanup can remove listeners
      openWhenReady.cleanup = () => {
        window.removeEventListener('resize', handleResize);
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
  }, [sessionId]);

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
