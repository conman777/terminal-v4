import { useEffect, useRef, useState } from 'react';

export function useTerminalStream(sessionId) {
  const [events, setEvents] = useState([]);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return undefined;
    }

    const source = new EventSource(`/api/terminal/${sessionId}/stream`);
    eventSourceRef.current = source;

    source.addEventListener('data', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setEvents((prev) => [...prev, { role: 'terminal', ...payload }]);
      } catch (err) {
        console.error('[Terminal Stream] Failed to parse event data:', err);
      }
    });

    source.addEventListener('end', () => {
      source.close();
    });

    source.onerror = () => {
      // Allow EventSource to attempt automatic reconnect.
    };

    return () => {
      source.close();
    };
  }, [sessionId]);

  return events;
}
