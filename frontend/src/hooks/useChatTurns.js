import { useState, useRef, useCallback } from 'react';

/**
 * Strips ANSI escape sequences and control characters from raw terminal output.
 * Handles CSI sequences, OSC sequences, and standalone escape chars.
 */
function stripAnsi(str) {
  return str
    // CSI sequences: ESC [ ... final-byte
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: ESC ] ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // Remaining 2-char escape sequences
    .replace(/\x1b./g, '')
    // Non-printable control characters except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

const IDLE_TIMEOUT_MS = 800;

/**
 * Tracks terminal I/O and groups it into conversation turns.
 *
 * Usage:
 *   const { turns, streamingContent, handleUserSend, handleOutputChunk } = useChatTurns();
 *
 * Pass handleUserSend as onSendMessage to TerminalChat.
 * Pass handleOutputChunk as onOutputChunk to TerminalChat.
 */
export function useChatTurns() {
  const [turns, setTurns] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');

  const bufferRef = useRef('');
  const idleTimerRef = useRef(null);

  const flushAssistantTurn = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    const content = bufferRef.current.trim();
    if (content) {
      setTurns(prev => [...prev, { role: 'assistant', content, ts: Date.now() }]);
    }
    bufferRef.current = '';
    setStreamingContent('');
  }, []);

  /**
   * Call this when the user sends a message to the terminal.
   * Flushes any in-progress assistant turn first.
   */
  const handleUserSend = useCallback((text) => {
    flushAssistantTurn();
    const cleaned = text.replace(/\r?\n$/, '').trim();
    if (cleaned) {
      setTurns(prev => [...prev, { role: 'user', content: cleaned, ts: Date.now() }]);
    }
  }, [flushAssistantTurn]);

  /**
   * Call this for each raw output chunk arriving from the terminal.
   */
  const handleOutputChunk = useCallback((raw) => {
    const stripped = stripAnsi(raw);
    if (!stripped) return;

    bufferRef.current += stripped;
    setStreamingContent(bufferRef.current.trim());

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(flushAssistantTurn, IDLE_TIMEOUT_MS);
  }, [flushAssistantTurn]);

  const clearTurns = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    bufferRef.current = '';
    setTurns([]);
    setStreamingContent('');
  }, []);

  return { turns, streamingContent, handleUserSend, handleOutputChunk, clearTurns };
}
