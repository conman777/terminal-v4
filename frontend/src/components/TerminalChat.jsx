import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function TerminalChat({ sessionId }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!sessionId || !terminalRef.current) return;

    // Create xterm instance
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

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Load history
    (async () => {
      const response = await fetch(`/api/terminal/${sessionId}/history`);
      if (response.ok) {
        const data = await response.json();
        data.history.forEach((entry) => {
          term.write(entry.text);
        });
      }
    })();

    // Connect to SSE stream
    const source = new EventSource(`/api/terminal/${sessionId}/stream`);
    eventSourceRef.current = source;

    source.addEventListener('data', (event) => {
      try {
        const payload = JSON.parse(event.data);
        term.write(payload.text);
      } catch (err) {
        console.error('[Terminal Stream] Failed to parse event data:', err);
      }
    });

    source.addEventListener('end', () => {
      term.write('\r\n[Terminal session ended]\r\n');
      source.close();
    });

    source.onerror = () => {
      source.close();
    };

    // Handle user input
    term.onData((data) => {
      fetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: data })
      });
    });

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
    };
  }, [sessionId]);

  return (
    <div className="terminal-chat">
      <div ref={terminalRef} className="xterm-container" style={{ height: '100%', width: '100%' }}></div>
    </div>
  );
}
