import { useState, useCallback, useEffect, useRef } from 'react';
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

  // Ref so the send function registered by TerminalChat is always fresh.
  const sendToTerminalRef = useRef(null);

  // Track which session we've seeded to avoid redundant fetches.
  const seededSessionRef = useRef(null);

  // Buffer turns that arrive before the initial fetch completes, so we don't
  // miss live turns during the HTTP round-trip.
  const pendingTurnsRef = useRef([]);
  const seededRef = useRef(false);

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
    sendToTerminalRef.current = fn;
  }, []);

  // Send a message from the chat input bar.
  const handleChatSend = useCallback((text) => {
    sendToTerminalRef.current?.(text + '\n');
  }, []);

  // Send Ctrl-C to interrupt Claude.
  const handleInterrupt = useCallback(() => {
    sendToTerminalRef.current?.('\x03');
  }, []);

  // Clear turns when session changes.
  useEffect(() => {
    setTurns([]);
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
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleInterrupt,
  };
}
