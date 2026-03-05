import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';

/**
 * Manages chat turns for the mobile conversation view.
 *
 * On mount (when chatMode becomes true) fetches the full turn history from
 * /api/terminal/:id/turns.  Thereafter, new turns arrive as structured
 * {type:"turn"} WebSocket events via TerminalChat's onTurn prop and are
 * appended to state.  No xterm.js rendering, no idle timers, no scraping.
 */
export function useMobileChatTurns({ sessionId, chatMode }) {
  const [turns, setTurns] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSendReady, setIsSendReady] = useState(false);

  // Ref so the send function registered by TerminalChat is always fresh.
  const sendToTerminalRef = useRef(null);
  const pendingInputsRef = useRef([]);
  const retryFlushTimerRef = useRef(null);

  // Track which session we've seeded to avoid redundant fetches.
  const seededSessionRef = useRef(null);

  // Buffer turns that arrive before the initial fetch completes, so we don't
  // miss live turns during the HTTP round-trip.
  const pendingTurnsRef = useRef([]);
  const seededRef = useRef(false);

  const flushPendingInputs = useCallback(() => {
    const sender = sendToTerminalRef.current;
    if (!sender || pendingInputsRef.current.length === 0) return true;

    const queued = pendingInputsRef.current;
    pendingInputsRef.current = [];
    for (let index = 0; index < queued.length; index += 1) {
      const input = queued[index];
      const accepted = sender(input);
      if (accepted === false) {
        pendingInputsRef.current = queued.slice(index);
        return false;
      }
    }
    return true;
  }, []);

  const schedulePendingFlush = useCallback(() => {
    if (retryFlushTimerRef.current) return;
    retryFlushTimerRef.current = setTimeout(() => {
      retryFlushTimerRef.current = null;
      const flushed = flushPendingInputs();
      if (!flushed && pendingInputsRef.current.length > 0) {
        schedulePendingFlush();
      }
    }, 75);
  }, [flushPendingInputs]);

  // Called by TerminalChat whenever a structured turn arrives over WebSocket.
  const handleTurn = useCallback((turn) => {
    if (seededRef.current) {
      setTurns(prev => [...prev, turn]);
    } else {
      pendingTurnsRef.current.push(turn);
    }
  }, []);

  // Called by TerminalChat to register the send-to-PTY function.
  const handleRegisterSendText = useCallback((fn) => {
    if (typeof fn !== 'function') {
      sendToTerminalRef.current = null;
      setIsSendReady(false);
      return;
    }

    sendToTerminalRef.current = fn;
    setIsSendReady(true);

    const flushed = flushPendingInputs();
    if (!flushed && pendingInputsRef.current.length > 0) {
      schedulePendingFlush();
    }
  }, [flushPendingInputs, schedulePendingFlush]);

  const sendOrQueue = useCallback((input) => {
    const sender = sendToTerminalRef.current;
    if (sender) {
      const accepted = sender(input);
      if (accepted === false) {
        pendingInputsRef.current.push(input);
        schedulePendingFlush();
        return { queued: true };
      }
      return { queued: false };
    }
    pendingInputsRef.current.push(input);
    return { queued: true };
  }, [schedulePendingFlush]);

  // Send a message from the chat input bar.
  const handleChatSend = useCallback((text) => {
    return sendOrQueue(text + '\r');
  }, [sendOrQueue]);

  // Send raw key/input data directly to the terminal transport.
  const handleRawSend = useCallback((data) => {
    return sendOrQueue(data);
  }, [sendOrQueue]);

  // Send Ctrl-C to interrupt Claude.
  const handleInterrupt = useCallback(() => {
    return sendOrQueue('\x03');
  }, [sendOrQueue]);

  // Clear turns when session changes.
  // Reset synchronously on session switch so child registration effects can
  // re-register sender afterward without being clobbered by a late parent effect.
  useLayoutEffect(() => {
    setTurns([]);
    setIsSendReady(false);
    sendToTerminalRef.current = null;
    pendingInputsRef.current = [];
    if (retryFlushTimerRef.current) {
      clearTimeout(retryFlushTimerRef.current);
      retryFlushTimerRef.current = null;
    }
    seededRef.current = false;
    seededSessionRef.current = null;
    pendingTurnsRef.current = [];
  }, [sessionId]);

  // Fetch initial turn history when entering chat mode for the first time.
  useEffect(() => {
    if (!chatMode || !sessionId) return;
    if (seededSessionRef.current === sessionId) return;

    let cancelled = false;
    setIsLoading(true);

    apiFetch(`/api/terminal/${sessionId}/turns`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const fetched = Array.isArray(data?.turns) ? data.turns : [];
        // Apply fetched history then flush any live turns that arrived during the fetch.
        setTurns([...fetched, ...pendingTurnsRef.current]);
        pendingTurnsRef.current = [];
        seededRef.current = true;
        seededSessionRef.current = sessionId;
      })
      .catch(() => {
        if (cancelled) return;
        // Seeding failed — still apply any buffered live turns.
        setTurns([...pendingTurnsRef.current]);
        pendingTurnsRef.current = [];
        seededRef.current = true;
        seededSessionRef.current = sessionId;
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      setIsLoading(false);
    };
  }, [chatMode, sessionId]);

  return {
    turns,
    isLoading,
    isSendReady,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleRawSend,
    handleInterrupt,
  };
}
