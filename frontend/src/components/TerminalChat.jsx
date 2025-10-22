import { useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalStream } from '../hooks/useTerminalStream';

export function TerminalChat({ sessionId }) {
  const logRef = useRef(null);
  const prevStreamLengthRef = useRef(0);
  const streamEvents = useTerminalStream(sessionId);
  const [history, setHistory] = useState([]);
  const [command, setCommand] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setHistory([]);
      prevStreamLengthRef.current = 0;
      return;
    }

    prevStreamLengthRef.current = 0;
    (async () => {
      const response = await fetch(`/api/terminal/${sessionId}/history`);
      if (response.ok) {
        const data = await response.json();
        setHistory(data.history.map((entry) => ({ role: 'terminal', text: entry.plain })));
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    if (streamEvents.length === 0) return;

    // Only append NEW events, not the entire array
    const newEvents = streamEvents.slice(prevStreamLengthRef.current);
    if (newEvents.length > 0) {
      setHistory((prev) => [...prev, ...newEvents.map((entry) => ({ role: 'terminal', text: entry.plain }))]);
      prevStreamLengthRef.current = streamEvents.length;
    }
  }, [streamEvents]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [history]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || !sessionId) return;

    setHistory((prev) => [...prev, { role: 'user', text: trimmed }]);
    setCommand('');

    await fetch(`/api/terminal/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: trimmed })
    });
  };

  const groupedHistory = useMemo(() => history.map((entry, index) => ({ ...entry, id: `log-${index}` })), [history]);

  return (
    <div className="terminal-chat">
      <div ref={logRef} className="terminal-log">
        {groupedHistory.map((entry) => (
          <div key={entry.id} className={`terminal-line ${entry.role}`}>
            {entry.text}
          </div>
        ))}
      </div>
      <form className="terminal-input" onSubmit={handleSubmit}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Type a shell command…"
        />
        <button type="submit" disabled={!command.trim()}>Send</button>
      </form>
    </div>
  );
}
