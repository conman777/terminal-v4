import { resolveApiUrl } from '../utils/apiBase';
import { useEffect, useState } from 'react';
import { getAccessToken } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { getEnvironmentSignal } from '../utils/remoteEnvironments';
import { createTerminalReconnectController } from '../utils/terminalSocketReconnect';
import { hasTerminalHistoryGap, unseenTerminalEvents } from '../utils/terminalHistoryReplay';

const MAX_STREAM_EVENTS = 500;

export function useTerminalStream(sessionId) {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    let disposed = false;
    let lastSeq = 0;
    let source = null;
    let recovering = false;
    const environmentSignal = getEnvironmentSignal();
    setEvents([]);
    if (!sessionId) return undefined;
    const current = () => !disposed && !environmentSignal.aborted && !controller.isStopped();
    const acceptEvents = (incoming, reset = false) => {
      const next = unseenTerminalEvents(incoming, reset ? 0 : lastSeq);
      for (const event of next) {
        if (Number.isSafeInteger(event.seq)) lastSeq = Math.max(lastSeq, event.seq);
      }
      setEvents(previous => [...(reset ? [] : previous), ...next.map(payload => ({ role: 'terminal', ...payload }))].slice(-MAX_STREAM_EVENTS));
    };
    const controller = createTerminalReconnectController(() => connect());
    const stop = () => {
      controller.stop();
      const old = source;
      source = null;
      old?.close();
    };
    const recover = async () => {
      if (!current() || recovering) return;
      recovering = true;
      const old = source;
      source = null;
      old?.close();
      try {
        const response = await apiFetch('/api/terminal/' + encodeURIComponent(sessionId) + '/history?historyEvents=500&historyChars=200000&afterSeq=' + lastSeq);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) {
          stop();
          return;
        }
        if (response.ok) {
          const snapshot = await response.json();
          if (!current()) return;
          const history = Array.isArray(snapshot.history) ? snapshot.history : [];
          acceptEvents(history, hasTerminalHistoryGap(history, lastSeq));
        }
      } catch (error) {
        if (error?.message === 'Session expired') {
          stop();
          return;
        }
      } finally {
        recovering = false;
      }
      if (current()) controller.scheduleReconnect();
    };
    function connect() {
      if (!current() || source) return;
      if (navigator.onLine === false) {
        controller.scheduleReconnect();
        return;
      }
      const params = new URLSearchParams({ historyEvents: String(MAX_STREAM_EVENTS), historyChars: '200000' });
      const token = getAccessToken();
      if (token) params.set('token', token);
      if (lastSeq > 0) params.set('afterSeq', String(lastSeq));
      const next = new EventSource(resolveApiUrl('/api/terminal/' + encodeURIComponent(sessionId) + '/stream?' + params.toString()));
      source = next;
      next.onopen = () => { if (current() && source === next) controller.markConnected(); };
      next.addEventListener('data', event => {
        if (!current() || source !== next) return;
        try {
          const payload = JSON.parse(event.data);
          if (hasTerminalHistoryGap([payload], lastSeq)) {
            void recover();
            return;
          }
          acceptEvents([payload]);
        } catch { /* Ignore malformed stream events. */ }
      });
      next.addEventListener('end', () => { if (source === next) stop(); });
      next.onerror = () => { if (source === next) void recover(); };
    }
    environmentSignal.addEventListener('abort', stop, { once: true });
    const offline = () => {
      const old = source;
      source = null;
      old?.close();
      if (current()) controller.scheduleReconnect();
    };
    window.addEventListener('offline', offline);
    connect();
    return () => {
      disposed = true;
      environmentSignal.removeEventListener('abort', stop);
      window.removeEventListener('offline', offline);
      controller.dispose();
      source?.close();
      source = null;
    };
  }, [sessionId]);

  return events;
}
