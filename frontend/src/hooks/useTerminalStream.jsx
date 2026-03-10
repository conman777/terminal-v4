import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../utils/auth';

const MAX_STREAM_EVENTS = 500;

export function useTerminalStream(sessionId) {
  const [events, setEvents] = useState([]);
  const eventSourceRef = useRef(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;

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
      if (disposedRef.current) {
        return;
      }

      try {
        const payload = JSON.parse(event.data);
        setEvents((prev) => {
          const nextEvents = [...prev, { role: 'terminal', ...payload }];
          return nextEvents.length > MAX_STREAM_EVENTS
            ? nextEvents.slice(-MAX_STREAM_EVENTS)
            : nextEvents;
        });
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
      disposedRef.current = true;
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
      source.close();
    };
  }, [sessionId]);

  return events;
}
