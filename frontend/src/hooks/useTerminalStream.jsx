import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../utils/auth';

export function useTerminalStream(sessionId) {
  const [events, setEvents] = useState([]);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return undefined;
    }

    const token = getAccessToken();
    const streamUrl = token
      ? `/api/terminal/${sessionId}/stream?token=${encodeURIComponent(token)}`
      : `/api/terminal/${sessionId}/stream`;
    const source = new EventSource(streamUrl);
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

    source.onerror = (err) => {
      console.warn('[Terminal Stream] EventSource error, will retry:', err);
    };

    return () => {
      source.close();
    };
  }, [sessionId]);

  return events;
}
