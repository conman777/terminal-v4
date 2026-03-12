import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api';
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
  const windowActiveRef = useRef(windowActive);

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

  // WebSocket connection
  useEffect(() => {
    if (!sessionId || !active) return;

    // Reset state on session change
    setMessages([]);
    setCurrentToolCalls([]);
    setPendingApproval(null);
    setIsStreaming(false);
    setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/structured/sessions/${sessionId}/ws`;

    function connect() {
      if (!windowActiveRef.current) {
        return;
      }
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState('online');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.__terminal_meta && data.type === 'structured_event' && data.event) {
            processEvent(data.event);
          }
        } catch {
          // Invalid JSON
        }
      };

      ws.onclose = () => {
        setConnectionState('offline');
        wsRef.current = null;
        if (!windowActiveRef.current) {
          return;
        }
        // Auto-reconnect after 3s
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connectRef.current = connect;
    connect();

    return () => {
      connectRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, active, processEvent]);

  useEffect(() => {
    if (!windowActive || !active || !sessionId) {
      return;
    }
    if (wsRef.current || reconnectTimerRef.current) {
      return;
    }
    connectRef.current?.();
  }, [active, sessionId, windowActive]);

  const sendMessage = useCallback(
    async (text) => {
      if (!sessionId || !text?.trim()) return;

      // Add user message to local state immediately
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text.trim(), ts: Date.now() },
      ]);

      // Send via REST (not WS) so we get a proper HTTP response
      try {
        await apiFetch(`/api/structured/sessions/${sessionId}/message`, {
          method: 'POST',
          body: { text: text.trim() },
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
