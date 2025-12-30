import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ToolCallBlock from './ToolCallBlock';
import ClaudeCodeInput from './ClaudeCodeInput';
import { FolderBrowserModal } from './FolderBrowserModal';
import { apiFetch } from '../utils/api';
import { getAccessToken } from '../utils/auth';

// Status bar component
function StatusBar({ sessionId, model, isConnected, isProcessing, eventCount }) {
  return (
    <div className="claude-status-bar">
      <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
      <span className="status-text">
        {isConnected ? 'Connected' : 'Disconnected'}
      </span>
      <span className="status-separator">•</span>
      <span className="status-model">{model || 'sonnet'}</span>
      {sessionId && (
        <>
          <span className="status-separator">•</span>
          <span className="status-session" title={sessionId}>
            {sessionId.slice(0, 15)}...
          </span>
        </>
      )}
      {eventCount > 0 && (
        <>
          <span className="status-separator">•</span>
          <span className="status-events">{eventCount} events</span>
        </>
      )}
      {isProcessing && (
        <span className="status-processing">
          <span className="processing-dot" />
          Working...
        </span>
      )}
    </div>
  );
}

// Format relative time
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Section header component
function SectionHeader({ turnNumber, timestamp }) {
  return (
    <div className="cc-section-header">
      <span className="cc-section-turn">Turn {turnNumber}</span>
      {timestamp && (
        <span className="cc-section-time">{formatRelativeTime(timestamp)}</span>
      )}
    </div>
  );
}

// Helper to group tool_use with tool_result and add section headers
function groupEvents(events) {
  const grouped = [];
  let currentToolUse = null;
  let turnNumber = 0;
  let lastUserTimestamp = null;

  for (const event of events) {
    // Start a new turn when we see a user message
    if (event.type === 'user') {
      // Push pending tool_use if any
      if (currentToolUse) {
        grouped.push(currentToolUse);
        currentToolUse = null;
      }

      turnNumber++;
      lastUserTimestamp = event.timestamp;

      // Add section header before user message
      grouped.push({
        type: 'section_header',
        id: `section-${turnNumber}`,
        turnNumber,
        timestamp: event.timestamp
      });
      grouped.push(event);
    } else if (event.type === 'tool_use') {
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

export default function ClaudeCodePanel({ sessionId, cwd, model, recentFolders, onFolderChange, onModelChange, onSessionEnd }) {
  const [events, setEvents] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [inputHistory, setInputHistory] = useState([]);
  const messagesEndRef = useRef(null);
  const eventSourceRef = useRef(null);
  const seenEventIdsRef = useRef(new Set());
  const lastEventTimeRef = useRef(0);
  const pendingEventsRef = useRef([]);
  const batchTimeoutRef = useRef(null);

  // Auto-scroll to bottom on new events (use instant scroll during rapid output to avoid animation queue buildup)
  useEffect(() => {
    const timeSinceLastEvent = Date.now() - lastEventTimeRef.current;
    const behavior = timeSinceLastEvent < 100 ? 'instant' : 'smooth';
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, [events]);

  // Model picker options
  const MODELS = ['sonnet', 'opus', 'haiku'];

  // Model picker keyboard navigation
  useEffect(() => {
    if (!showModelPicker) return;

    const handleKeyDown = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setModelPickerIndex(i => (i + 1) % MODELS.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setModelPickerIndex(i => (i - 1 + MODELS.length) % MODELS.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleModelSelect(MODELS[modelPickerIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowModelPicker(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModelPicker, modelPickerIndex]);

  // Connect to SSE stream with retry logic
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 5;

  useEffect(() => {
    if (!sessionId) return;

    // Clear events when switching sessions
    setEvents([]);
    setIsConnected(false);
    setIsProcessing(false);
    seenEventIdsRef.current.clear();
    retryCountRef.current = 0;

    let reconnectTimeout = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;

      if (retryCountRef.current >= MAX_RETRIES) {
        console.error('Max SSE reconnection attempts reached');
        setIsConnected(false);
        setIsProcessing(false);
        return;
      }

      // Close any existing connection first
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // EventSource doesn't support headers, so pass token via query param
      const token = getAccessToken();
      const streamUrl = `/api/claude-code/${sessionId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setIsConnected(true);
        retryCountRef.current = 0; // Reset on successful connection
      };

      eventSource.addEventListener('event', (e) => {
        let event;
        try {
          event = JSON.parse(e.data);
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
          return;
        }

        // Generate synthetic ID for events without one to enable deduplication
        const eventId = event?.id || `synthetic-${event.type}-${event.timestamp}-${JSON.stringify(event.content || event.tool || '').substring(0, 50)}`;

        if (seenEventIdsRef.current.has(eventId)) {
          return;
        }
        seenEventIdsRef.current.add(eventId);
        lastEventTimeRef.current = Date.now();

        // Batch events to reduce render frequency during rapid output
        pendingEventsRef.current.push({ ...event, id: event.id || eventId });

        if (!batchTimeoutRef.current) {
          batchTimeoutRef.current = setTimeout(() => {
            if (pendingEventsRef.current.length > 0) {
              setEvents(prev => [...prev, ...pendingEventsRef.current]);
              pendingEventsRef.current = [];
            }
            batchTimeoutRef.current = null;
          }, 50);
        }

        // Track processing state (immediate, not batched, for responsive UI feedback)
        if (event.type === 'tool_use') {
          setIsProcessing(true);
        } else if (event.type === 'assistant' || event.type === 'result' || (event.type === 'system' && event.isError)) {
          setIsProcessing(false);
        }
      });

      eventSource.addEventListener('history-complete', () => {
        // History loaded, now receiving live events
      });

      eventSource.onerror = () => {
        if (disposed) return;
        setIsConnected(false);
        setIsProcessing(false); // Reset processing state on connection error
        retryCountRef.current++;

        // Close current connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        // Manual retry with exponential backoff
        if (!disposed && retryCountRef.current < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
          reconnectTimeout = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current);
        batchTimeoutRef.current = null;
      }
      pendingEventsRef.current = [];
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsProcessing(false); // Reset when unmounting/switching sessions
    };
  }, [sessionId]);

  const handleSend = useCallback(async (text) => {
    if (!text.trim() || !sessionId) return;

    // Handle slash commands locally
    const trimmed = text.trim().toLowerCase();

    // Add to history (skip slash commands)
    if (!text.startsWith('/')) {
      setInputHistory(prev => [...prev, text]);
    }

    if (trimmed === '/model') {
      // Set initial index to current model
      const currentModelIndex = MODELS.indexOf(model || 'sonnet');
      setModelPickerIndex(currentModelIndex >= 0 ? currentModelIndex : 0);
      setShowModelPicker(true);
      const cmdEvent = {
        id: `cmd-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: `Current model: ${model || 'sonnet'}. Select a new model below.`
      };
      setEvents(prev => [...prev, cmdEvent]);
      return;
    }

    if (trimmed === '/clear') {
      setEvents([]);
      seenEventIdsRef.current.clear();
      const cmdEvent = {
        id: `cmd-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: 'Conversation cleared.'
      };
      setEvents([cmdEvent]);
      return;
    }

    if (trimmed === '/help') {
      const cmdEvent = {
        id: `cmd-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: `Available commands:
/model - Change AI model
/clear - Clear conversation
/help - Show this help
/compact - Toggle compact mode (coming soon)
/cost - Show token usage (coming soon)`
      };
      setEvents(prev => [...prev, cmdEvent]);
      return;
    }

    if (trimmed === '/compact' || trimmed === '/cost') {
      const cmdEvent = {
        id: `cmd-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: `${trimmed} - Coming soon!`
      };
      setEvents(prev => [...prev, cmdEvent]);
      return;
    }

    // Set processing BEFORE fetch to avoid race with SSE events
    setIsProcessing(true);

    try {
      const res = await apiFetch(`/api/claude-code/${sessionId}/input`, {
        method: 'POST',
        body: { text }
      });
      if (!res.ok) {
        setIsProcessing(false);
      }
      // Don't set isProcessing(true) here - SSE events will manage it
    } catch (error) {
      console.error('Failed to send input:', error);
      setIsProcessing(false);
    }
  }, [sessionId, model]);

  const handleModelSelect = useCallback(async (newModel) => {
    setShowModelPicker(false);
    try {
      const res = await apiFetch(`/api/claude-code/${sessionId}/model`, {
        method: 'PATCH',
        body: { model: newModel }
      });
      if (res.ok) {
        const updated = await res.json();
        if (onModelChange) {
          onModelChange(updated);
        }
        // Add confirmation event
        const confirmEvent = {
          id: `cmd-${Date.now()}`,
          type: 'system',
          timestamp: Date.now(),
          content: `Model changed to ${newModel}`
        };
        setEvents(prev => [...prev, confirmEvent]);
      }
    } catch (error) {
      console.error('Failed to update model:', error);
    }
  }, [sessionId, onModelChange]);

  // Handle cancel (Escape key)
  const handleCancel = useCallback(async () => {
    if (!sessionId || !isProcessing) return;

    try {
      await apiFetch(`/api/claude-code/${sessionId}/stop`, { method: 'POST' });
      // Add system event to show cancellation
      const cancelEvent = {
        id: `cancel-${Date.now()}`,
        type: 'system',
        timestamp: Date.now(),
        content: 'Request cancelled by user'
      };
      setEvents(prev => [...prev, cancelEvent]);
      setIsProcessing(false);
    } catch (error) {
      console.error('Failed to cancel:', error);
    }
  }, [sessionId, isProcessing]);

  // Group tool_use with its corresponding tool_result (memoized to avoid reprocessing on every render)
  const groupedEvents = useMemo(() => groupEvents(events), [events]);

  const handleFolderSelect = (newPath) => {
    if (onFolderChange) {
      onFolderChange(newPath);
    }
  };

  // Handle file:line click - copy to clipboard
  const handleFileClick = useCallback((path, line) => {
    navigator.clipboard.writeText(`${path}:${line}`).then(() => {
      // Could add a toast notification here
      console.log(`Copied to clipboard: ${path}:${line}`);
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  }, []);

  return (
    <div className="claude-code-panel">
      {/* Clickable header showing current folder */}
      {cwd && (
        <button
          className="claude-code-header"
          onClick={() => setShowFolderBrowser(true)}
          title="Click to change folder"
        >
          <span className="folder-icon">📁</span>
          <span className="folder-path">{cwd}</span>
          <span className="folder-edit-hint">Change</span>
        </button>
      )}

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
          groupedEvents.map((item, index) => {
            if (item.type === 'section_header') {
              return (
                <SectionHeader
                  key={item.id}
                  turnNumber={item.turnNumber}
                  timestamp={item.timestamp}
                />
              );
            }
            return (
              <ToolCallBlock key={item.id || index} item={item} onFileClick={handleFileClick} />
            );
          })
        )}

        {/* Model picker - shown when /model command is used */}
        {showModelPicker && (
          <div className="model-picker">
            <div className="model-picker-label">Select model (↑↓ to navigate, Enter to select):</div>
            <div className="model-picker-options">
              <button
                className={`model-option ${modelPickerIndex === 0 ? 'selected' : ''} ${model === 'sonnet' ? 'active' : ''}`}
                onClick={() => handleModelSelect('sonnet')}
              >
                claude-sonnet-4-20250514 {model === 'sonnet' && '✓'}
              </button>
              <button
                className={`model-option ${modelPickerIndex === 1 ? 'selected' : ''} ${model === 'opus' ? 'active' : ''}`}
                onClick={() => handleModelSelect('opus')}
              >
                claude-opus-4-20250514 {model === 'opus' && '✓'}
              </button>
              <button
                className={`model-option ${modelPickerIndex === 2 ? 'selected' : ''} ${model === 'haiku' ? 'active' : ''}`}
                onClick={() => handleModelSelect('haiku')}
              >
                claude-haiku-3-5-20241022 {model === 'haiku' && '✓'}
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <StatusBar
        sessionId={sessionId}
        model={model}
        isConnected={isConnected}
        isProcessing={isProcessing}
        eventCount={events.length}
      />

      <ClaudeCodeInput
        onSend={handleSend}
        disabled={!isConnected}
        isProcessing={isProcessing}
        history={inputHistory}
        onCancel={handleCancel}
      />

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        onClose={() => setShowFolderBrowser(false)}
        currentPath={cwd}
        recentFolders={recentFolders}
        onSelect={handleFolderSelect}
      />
    </div>
  );
}

