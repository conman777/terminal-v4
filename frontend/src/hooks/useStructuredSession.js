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
  const reconnectTimerRef = useRef(null);
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
    if (event.seq != null) {
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
    }
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

  // WebSocket connection
  useEffect(() => {
    if (!sessionId || !active) return;
    let disposed = false;

    // Reset state on session change (fresh connect, not reconnect)
    lastSeqRef.current = 0;
    isReconnectRef.current = false;
    setMessages([]);
    setCurrentToolCalls([]);
    setPendingApproval(null);
    setIsStreaming(false);
    setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    async function getFreshAccessToken() {
      const accessToken = getAccessToken();
      if (!accessToken || !isAccessTokenExpired(accessToken)) {
        return accessToken;
      }

      const refreshed = await refreshTokens();
      return refreshed.accessToken;
    }

    async function connect() {
      if (disposed || !windowActiveRef.current || isConnectingRef.current) {
        return;
      }
      isConnectingRef.current = true;
      let accessToken = null;
      try {
        accessToken = await getFreshAccessToken();
      } catch {
        accessToken = getAccessToken();
      }
      if (disposed || !windowActiveRef.current) {
        isConnectingRef.current = false;
        return;
      }
      const wsBaseUrl = `${protocol}//${window.location.host}/api/structured/sessions/${sessionId}/ws`;
      const params = new URLSearchParams();
      if (accessToken) params.set('token', accessToken);
      if (isReconnectRef.current && lastSeqRef.current > 0) {
        params.set('last_seq', String(lastSeqRef.current));
      }
      const wsUrl = `${wsBaseUrl}?${params.toString()}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      isConnectingRef.current = false;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) {
          return;
        }
        setConnectionState('online');
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) {
          return;
        }
        try {
          const data = JSON.parse(event.data);
          if (data.__terminal_meta && data.type === 'events_lost') {
            // Broadcast buffer overflow — trigger full resync
            lastSeqRef.current = 0;
            isReconnectRef.current = false;
            setMessages([]);
            setCurrentToolCalls([]);
            setPendingApproval(null);
            setIsStreaming(false);
            ws.close();
            return;
          }
          if (data.__terminal_meta && data.type === 'structured_event' && data.event) {
            processEvent(data.event);
          }
        } catch {
          // Invalid JSON
        }
      };

      ws.onclose = () => {
        isConnectingRef.current = false;
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (disposed || wsRef.current !== null) {
          return;
        }
        setConnectionState('offline');
        isReconnectRef.current = true;
        if (!windowActiveRef.current) {
          return;
        }
        // Auto-reconnect after 3s
        const reconnectTimer = setTimeout(() => {
          if (reconnectTimerRef.current === reconnectTimer) {
            reconnectTimerRef.current = null;
          }
          connect();
        }, 3000);
        reconnectTimerRef.current = reconnectTimer;
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connectRef.current = connect;
    connect();

    return () => {
      disposed = true;
      connectRef.current = null;
      isConnectingRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        const currentSocket = wsRef.current;
        wsRef.current = null;
        currentSocket.close();
      }
    };
  }, [sessionId, active, processEvent]);

  useEffect(() => {
    if (!windowActive || !active || !sessionId) {
      return;
    }
    if (wsRef.current || reconnectTimerRef.current || isConnectingRef.current) {
      return;
    }
    connectRef.current?.();
  }, [active, sessionId, windowActive]);

  const sendMessage = useCallback(
    async (text) => {
      if (!sessionId || !text?.trim()) return;
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
    if (!sessionId) return;
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
      if (!sessionId) return;
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
