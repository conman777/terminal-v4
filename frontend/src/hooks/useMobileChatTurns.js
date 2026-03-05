import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';

function normalizeTurnContent(content) {
  return typeof content === 'string' ? content.trim() : '';
}

function areSameTurn(a, b) {
  return Boolean(
    a
    && b
    && a.role === b.role
    && normalizeTurnContent(a.content) === normalizeTurnContent(b.content)
  );
}

function mergeDistinctTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    const normalizedContent = normalizeTurnContent(turn?.content);
    if (!normalizedContent) continue;

    const normalizedTurn = {
      ...turn,
      content: normalizedContent
    };

    if (!areSameTurn(merged[merged.length - 1], normalizedTurn)) {
      merged.push(normalizedTurn);
    }
  }
  return merged;
}

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
  const turnsRef = useRef([]);
  const delayedSubmitTimerRef = useRef(null);

  // Ref so the send function registered by TerminalChat is always fresh.
  const sendToTerminalRef = useRef(null);
  const pendingInputsRef = useRef([]);
  const retryFlushTimerRef = useRef(null);
  const optimisticUserTurnsRef = useRef([]);

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
    if (!turn || typeof turn.content !== 'string') return;

    const normalizedContent = normalizeTurnContent(turn.content);
    if (!normalizedContent) return;

    const normalizedTurn = {
      ...turn,
      content: normalizedContent
    };

    const currentTurns = turnsRef.current;
    if (normalizedTurn.role === 'user') {
      const optimisticMatchIndex = currentTurns.findIndex((item) => (
        item?.role === 'user'
        && item?.optimistic === true
        && item.content === normalizedContent
      ));

      if (optimisticMatchIndex !== -1) {
        const next = [...currentTurns];
        next.splice(optimisticMatchIndex, 1, normalizedTurn);
        turnsRef.current = next;
        setTurns(next);
        optimisticUserTurnsRef.current = optimisticUserTurnsRef.current.filter((item) => item !== normalizedContent);

        if (!seededRef.current) {
          const pendingTurns = pendingTurnsRef.current;
          if (!areSameTurn(pendingTurns[pendingTurns.length - 1], normalizedTurn)) {
            pendingTurnsRef.current.push(normalizedTurn);
          }
        }
        return;
      }
    }

    if (seededRef.current) {
      if (areSameTurn(currentTurns[currentTurns.length - 1], normalizedTurn)) {
        return;
      }

      const next = [...currentTurns, normalizedTurn];
      turnsRef.current = next;
      setTurns(next);
    } else {
      const pendingTurns = pendingTurnsRef.current;
      if (!areSameTurn(pendingTurns[pendingTurns.length - 1], normalizedTurn)) {
        pendingTurnsRef.current.push(normalizedTurn);
      }
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
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const textResult = sendOrQueue(text);
    const submit = () => sendOrQueue('\r');

    if (textResult.queued) {
      submit();
    } else {
      if (delayedSubmitTimerRef.current) {
        clearTimeout(delayedSubmitTimerRef.current);
      }
      delayedSubmitTimerRef.current = setTimeout(() => {
        delayedSubmitTimerRef.current = null;
        submit();
      }, 35);
    }

    if (trimmed) {
      optimisticUserTurnsRef.current.push(trimmed);
      const next = [
        ...turnsRef.current,
        {
          role: 'user',
          content: trimmed,
          ts: Date.now(),
          optimistic: true
        }
      ];
      turnsRef.current = next;
      setTurns(next);
    }

    return { queued: textResult.queued };
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
    turnsRef.current = [];
    setTurns([]);
    setIsSendReady(false);
    sendToTerminalRef.current = null;
    pendingInputsRef.current = [];
    optimisticUserTurnsRef.current = [];
    if (retryFlushTimerRef.current) {
      clearTimeout(retryFlushTimerRef.current);
      retryFlushTimerRef.current = null;
    }
    if (delayedSubmitTimerRef.current) {
      clearTimeout(delayedSubmitTimerRef.current);
      delayedSubmitTimerRef.current = null;
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
        const next = mergeDistinctTurns([...fetched, ...pendingTurnsRef.current]);
        turnsRef.current = next;
        setTurns(next);
        pendingTurnsRef.current = [];
        seededRef.current = true;
        seededSessionRef.current = sessionId;
      })
      .catch(() => {
        if (cancelled) return;
        // Seeding failed — still apply any buffered live turns.
        const next = mergeDistinctTurns(pendingTurnsRef.current);
        turnsRef.current = next;
        setTurns(next);
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
