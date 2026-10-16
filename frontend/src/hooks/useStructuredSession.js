import { environmentAllows } from '../utils/runtimePermissions';
import { getActiveEnvironment, getEnvironmentSignal } from '../utils/remoteEnvironments';
import { createTerminalReconnectController, isPermanentSocketClose } from '../utils/terminalSocketReconnect';
import { resolveWebSocketUrl } from '../utils/apiBase';
import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api';
import { getAccessToken, isAccessTokenExpired, refreshTokens } from '../utils/auth';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

/**
 * Hook for consuming a structured session's canonical events via WebSocket.
 * Accumulates events into a messages/tool-calls model for rendering.
 */
export function useStructuredSession({ sessionId, active = true }) {
  const [messages, setMessages] = useState([]);
  const [currentToolCalls, setCurrentToolCalls] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionState, setConnectionState] = useState('connecting');
  const [windowActive, setWindowActive] = useState(() => isWindowActive());
  const wsRef = useRef(null);
  const reconnectControllerRef = useRef(null);
  const environmentSignalRef = useRef(getEnvironmentSignal());
  const connectRef = useRef(null);
  const isConnectingRef = useRef(false);
  const windowActiveRef = useRef(windowActive);
  const lastSeqRef = useRef(0);
  const isReconnectRef = useRef(false);

  useEffect(() => subscribeWindowActivity(setWindowActive), []);
  useEffect(() => {
    windowActiveRef.current = windowActive;
  }, [windowActive]);

  // Process a single canonical event into our rendering model
  const processEvent = useCallback((event) => {
    switch (event.type) {
      case 'session_started':
        setIsStreaming(true);
        break;

      case 'session_ended':
        setIsStreaming(false);
        break;

      case 'message_started':
        setIsStreaming(true);
        break;

      case 'message_delta':
        if (event.role === 'assistant') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              // Append to current streaming message
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + event.content },
              ];
            }
            // Start new streaming message
            return [
              ...prev,
              { role: 'assistant', content: event.content, ts: event.ts, streaming: true },
            ];
          });
          setIsStreaming(true);
        }
        break;

      case 'message_completed':
        if (event.role === 'assistant') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              return [
                ...prev.slice(0, -1),
                { role: 'assistant', content: event.content, ts: event.ts, streaming: false },
              ];
            }
            return [
              ...prev,
              { role: 'assistant', content: event.content, ts: event.ts, streaming: false },
            ];
          });
          setIsStreaming(false);
        }
        break;

      case 'tool_started':
        setCurrentToolCalls((prev) => [
          ...prev,
          {
            toolName: event.toolName,
            toolInput: event.toolInput,
            toolCallId: event.toolCallId,
            status: 'running',
            result: null,
          },
        ]);
        break;

      case 'tool_output':
        setCurrentToolCalls((prev) =>
          prev.map((tc) =>
            tc.toolCallId === event.toolCallId && tc.status === 'running'
              ? { ...tc, result: (tc.result || '') + event.output }
              : tc
          )
        );
        break;

      case 'tool_completed':
        setCurrentToolCalls((prev) => {
          const updated = prev.map((tc) =>
            tc.toolCallId === event.toolCallId && tc.status === 'running'
              ? { ...tc, status: 'completed', result: event.result, isError: event.isError }
              : tc
          );
          // Move completed tools into messages
          const completed = updated.filter((tc) => tc.status === 'completed');
          const remaining = updated.filter((tc) => tc.status !== 'completed');

          if (completed.length > 0) {
            setMessages((prev) => [
              ...prev,
              ...completed.map((tc) => ({
                role: 'tool',
                toolName: tc.toolName,
                toolInput: tc.toolInput,
                result: tc.result,
                isError: tc.isError,
                ts: event.ts,
              })),
            ]);
          }

          return remaining;
        });
        break;

      case 'approval_required':
        setPendingApproval({
          toolName: event.toolName,
          toolInput: event.toolInput,
          description: event.description,
          ts: event.ts,
        });
        break;

      case 'input_required':
        setPendingApproval({
          type: 'input',
          prompt: event.prompt,
          ts: event.ts,
        });
        break;

      case 'error':
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: event.message, ts: event.ts },
        ]);
        setIsStreaming(false);
        break;

      case 'status':
        // Could display status updates in UI if desired
        break;

      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !active) return;
    let disposed = false;
    const environmentSignal = environmentSignalRef.current;
    const remote = Boolean(getActiveEnvironment());
    lastSeqRef.current = 0;
    isReconnectRef.current = false;
    const resetModel = () => {
      lastSeqRef.current = 0;
      isReconnectRef.current = false;
      setMessages([]);
      setCurrentToolCalls([]);
      setPendingApproval(null);
      setIsStreaming(false);
    };
    resetModel();
    setConnectionState('connecting');

    const controller = createTerminalReconnectController(() => { void connect(); });
    reconnectControllerRef.current = controller;
    const stop = () => {
      controller.stop();
      isConnectingRef.current = false;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
      if (!disposed) setConnectionState('unavailable');
    };
    environmentSignal.addEventListener('abort', stop, { once: true });

    async function connect() {
      if (disposed || environmentSignal.aborted || controller.isStopped() || !windowActiveRef.current
        || isConnectingRef.current || wsRef.current) return;
      if (navigator.onLine === false) {
        controller.scheduleReconnect();
        return;
      }
      const attempt = controller.beginAttempt();
      isConnectingRef.current = true;
      let accessToken = getAccessToken();
      try {
        if (accessToken && isAccessTokenExpired(accessToken)) {
          accessToken = (await refreshTokens()).accessToken;
        }
      } catch (error) {
        if (!disposed && controller.isCurrentAttempt(attempt)) {
          isConnectingRef.current = false;
          if (['Token refresh failed', 'No refresh token', 'Invalid token response'].includes(error?.message)) stop();
          else controller.scheduleReconnect();
        }
        return;
      }
      if (disposed || environmentSignal.aborted || !controller.isCurrentAttempt(attempt)) return;
      if (!windowActiveRef.current || navigator.onLine === false) {
        isConnectingRef.current = false;
        return;
      }
      const params = new URLSearchParams();
      if (accessToken) params.set('token', accessToken);
      if (isReconnectRef.current && lastSeqRef.current > 0) params.set('last_seq', String(lastSeqRef.current));
      const ws = new WebSocket(resolveWebSocketUrl('/api/structured/sessions/' + encodeURIComponent(sessionId) + '/ws') + '?' + params.toString());
      wsRef.current = ws;
      isConnectingRef.current = false;
      const current = () => !disposed && !environmentSignal.aborted && wsRef.current === ws && controller.isCurrentAttempt(attempt);
      ws.onopen = () => {
        if (!current()) return;
        controller.markConnected();
        setConnectionState('online');
      };
      ws.onmessage = event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (data.__terminal_meta && data.type === 'events_lost') {
            resetModel();
            ws.close();
            return;
          }
          if (data.__terminal_meta && data.type === 'structured_event' && data.event) {
            const seq = data.event.seq;
            if (Number.isSafeInteger(seq) && seq > 0) {
              if (seq <= lastSeqRef.current) return;
              if (lastSeqRef.current > 0 && seq > lastSeqRef.current + 1) {
                resetModel();
                ws.close();
                return;
              }
              lastSeqRef.current = seq;
            }
            processEvent(data.event);
          }
        } catch { /* Ignore malformed transport events. */ }
      };
      ws.onclose = (event = {}) => {
        if (!current()) return;
        wsRef.current = null;
        isConnectingRef.current = false;
        if (isPermanentSocketClose(event, remote)) {
          stop();
          return;
        }
        setConnectionState('offline');
        isReconnectRef.current = true;
        controller.scheduleReconnect();
      };
      ws.onerror = () => { if (current()) ws.close(); };
    }

    const offline = () => { wsRef.current?.close(); };
    window.addEventListener('offline', offline);
    connectRef.current = connect;
    void connect();

    return () => {
      disposed = true;
      environmentSignal.removeEventListener('abort', stop);
      window.removeEventListener('offline', offline);
      controller.dispose();
      if (reconnectControllerRef.current === controller) reconnectControllerRef.current = null;
      connectRef.current = null;
      isConnectingRef.current = false;
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
  }, [sessionId, active, processEvent]);

  useEffect(() => {
    if (windowActive && active && sessionId) void connectRef.current?.();
  }, [active, sessionId, windowActive]);

  const sendMessage = useCallback(
    async (text) => {
      if (!sessionId || !text?.trim() || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return;
      const message = text.trim();

      // Add user message to local state immediately
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: message, ts: Date.now() },
      ]);

      try {
        await apiFetch(`/api/structured/sessions/${sessionId}/input`, {
          method: 'POST',
          body: { text: `${message}\n`, fallbackToMessage: true },
        });
      } catch (error) {
        console.error('Failed to send structured message:', error);
      }
    },
    [sessionId]
  );

  const interrupt = useCallback(async () => {
    if (!sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return;
    try {
      await apiFetch(`/api/structured/sessions/${sessionId}/interrupt`, {
        method: 'POST',
      });
    } catch (error) {
      console.error('Failed to interrupt structured session:', error);
    }
  }, [sessionId]);

  const approve = useCallback(
    async (approved) => {
      if (!sessionId || environmentSignalRef.current.aborted || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return;
      setPendingApproval(null);
      try {
        await apiFetch(`/api/structured/sessions/${sessionId}/approve`, {
          method: 'POST',
          body: { approved },
        });
      } catch (error) {
        console.error('Failed to send approval:', error);
      }
    },
    [sessionId]
  );

  return {
    messages,
    currentToolCalls,
    pendingApproval,
    isStreaming,
    connectionState,
    sendMessage,
    interrupt,
    approve,
  };
}
