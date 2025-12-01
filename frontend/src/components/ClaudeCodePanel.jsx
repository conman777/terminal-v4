import { useState, useEffect, useRef, useCallback } from 'react';
import ToolCallBlock from './ToolCallBlock';
import ClaudeCodeInput from './ClaudeCodeInput';

// Helper to group tool_use with tool_result
function groupEvents(events) {
  const grouped = [];
  let currentToolUse = null;

  for (const event of events) {
    if (event.type === 'tool_use') {
      // If there's a pending tool_use without result, push it
      if (currentToolUse) {
        grouped.push(currentToolUse);
      }
      currentToolUse = { ...event, result: null };
    } else if (event.type === 'tool_result' && currentToolUse) {
      currentToolUse.result = event;
      grouped.push(currentToolUse);
      currentToolUse = null;
    } else {
      // Push pending tool_use if any
      if (currentToolUse) {
        grouped.push(currentToolUse);
        currentToolUse = null;
      }
      grouped.push(event);
    }
  }

  // Don't forget trailing tool_use without result
  if (currentToolUse) {
    grouped.push(currentToolUse);
  }

  return grouped;
}

export default function ClaudeCodePanel({ sessionId, onSessionEnd }) {
  const [events, setEvents] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const messagesEndRef = useRef(null);
  const eventSourceRef = useRef(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // Connect to SSE stream
  useEffect(() => {
    if (!sessionId) return;

    // Clear events when switching sessions
    setEvents([]);
    setIsConnected(false);

    const eventSource = new EventSource(`/api/claude-code/${sessionId}/stream`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.addEventListener('event', (e) => {
      const event = JSON.parse(e.data);
      setEvents(prev => [...prev, event]);

      // Track processing state
      if (event.type === 'tool_use') {
        setIsProcessing(true);
      } else if (event.type === 'assistant' || event.type === 'result') {
        setIsProcessing(false);
      }
    });

    eventSource.addEventListener('history-complete', () => {
      // History loaded, now receiving live events
    });

    eventSource.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [sessionId]);

  const handleSend = useCallback(async (text) => {
    if (!text.trim() || !sessionId) return;

    try {
      await fetch(`/api/claude-code/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      setIsProcessing(true);
    } catch (error) {
      console.error('Failed to send input:', error);
    }
  }, [sessionId]);

  // Group tool_use with its corresponding tool_result
  const groupedEvents = groupEvents(events);

  return (
    <div className="claude-code-panel">
      <div className="claude-code-messages">
        {groupedEvents.length === 0 ? (
          <div className="claude-code-empty">
            <div className="empty-icon">🤖</div>
            <div className="empty-title">Claude Code</div>
            <div className="empty-subtitle">
              {isConnected ? 'Ready for your first message' : 'Connecting...'}
            </div>
          </div>
        ) : (
          groupedEvents.map((item, index) => (
            <ToolCallBlock key={item.id || index} item={item} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <ClaudeCodeInput
        onSend={handleSend}
        disabled={!isConnected}
        isProcessing={isProcessing}
      />
    </div>
  );
}

