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
      console.log('[Terminal Stream] Received data event:', event.data);
      try {
        const payload = JSON.parse(event.data);
        setEvents((prev) => [...prev, { role: 'terminal', ...payload }]);
      } catch (err) {
        console.error('[Terminal Stream] Failed to parse event data:', err);
      }
    });

    source.addEventListener('end', () => {
      console.log('[Terminal Stream] Received end event');
      source.close();
    });

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [sessionId]);

  return events;
}
