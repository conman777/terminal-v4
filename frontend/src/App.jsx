import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { TerminalChat } from './components/TerminalChat';

function parseSseBlock(block) {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const joined = dataLines.join('\n');
  let data;

  try {
    data = joined ? JSON.parse(joined) : null;
  } catch (error) {
    data = { raw: joined, parseError: error.message };
  }

  return { event, data };
}

function extractTextFragment(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  if (payload.delta && typeof payload.delta.text === 'string') {
    return payload.delta.text;
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => {
        if (!item) {
          return '';
        }

        if (typeof item === 'string') {
          return item;
        }

        if (item.text) {
          return item.text;
        }

        if (item.type === 'text' && item.value) {
          return item.value;
        }

        return '';
      })
      .join('');
  }

  if (payload.message && typeof payload.message === 'string') {
    return payload.message;
  }

  return '';
}

function describeToolEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.type === 'tool_call' && payload.tool) {
    const path = payload.path ? ` (${payload.path})` : '';
    return `Running ${payload.tool}${path}`.trim();
  }

  if (payload.tool && payload.event) {
    return `${payload.tool}: ${payload.event}`;
  }

  if (payload.file || payload.path) {
    const name = payload.file || payload.path;
    const action = payload.action || payload.event || 'activity';
    return `${action} ${name}`.trim();
  }

  return null;
}

function MarkdownRenderer({ content }) {
  if (!content) {
    return null;
  }

  return (
    <ReactMarkdown
      className="markdown"
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children }) {
          const match = /language-(\w+)/.exec(className || '');
          const text = String(children).replace(/\n$/, '');

          if (inline || !match) {
            return <code className={className}>{children}</code>;
          }

          const language = match[1];

          return (
            <Highlight code={text} language={language} theme={themes.oneDark}>
              {({ className: highlightClass, style, tokens, getLineProps, getTokenProps }) => (
                <pre className={`${highlightClass} code-block`} style={style}>
                  {tokens.map((line, lineIndex) => (
                    <div key={lineIndex} {...getLineProps({ line, key: lineIndex })}>
                      {line.map((token, tokenIndex) => (
                        <span key={tokenIndex} {...getTokenProps({ token, key: tokenIndex })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function MessageBubble({ message }) {
  return (
    <div className={`message ${message.role}`}>
      <MarkdownRenderer content={message.content || ''} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>Welcome to Claude Code Web</h2>
      <p>
        Describe what you want Claude to do and watch the CLI stream back its work, including every tool invocation
        along the way.
      </p>
    </div>
  );
}

function SessionSidebar({ sessions, activeSessionId, onSelectSession, onCreateSession, isLoading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <h1>Sessions</h1>
          <span className="sidebar-subtitle">Local Claude CLI</span>
        </div>
        <button className="sidebar-new" type="button" onClick={onCreateSession}>
          New
        </button>
      </div>
      <div className="session-list">
        {isLoading && <div className="session-placeholder">Loading sessions…</div>}
        {!isLoading && sessions.length === 0 && <div className="session-placeholder">No sessions yet</div>}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`session-card${session.id === activeSessionId ? ' active' : ''}`}
            onClick={() => onSelectSession(session.id)}
          >
            <div className="session-title">{session.title || 'Untitled session'}</div>
            <div className="session-preview">
              {session.preview ? session.preview : 'No assistant response yet'}
            </div>
            <div className="session-meta">
              <span>{session.messageCount} messages</span>
              <span>{new Date(session.updatedAt).toLocaleTimeString()}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const [inputValue, setInputValue] = useState('');
  const [conversation, setConversation] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [toolActivity, setToolActivity] = useState([]);
  const [statusText, setStatusText] = useState('Idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState(null);

  const chatAreaRef = useRef(null);
  const textareaRef = useRef(null);
  const streamControllerRef = useRef(null);
  const assistantMessageIdRef = useRef(null);
  const nextIdRef = useRef(0);
  const pendingSessionIdRef = useRef(null);
  const activeSessionIdRef = useRef(null);

  const allocateId = useCallback(() => {
    const id = `msg-${nextIdRef.current++}`;
    return id;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTo({ top: chatAreaRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [conversation, scrollToBottom]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [inputValue]);

  useEffect(() => {
    return () => {
      if (streamControllerRef.current) {
        streamControllerRef.current.abort();
      }
    };
  }, []);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }

      const data = await response.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (error) {
      console.error('Failed to load sessions', error);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const loadSession = useCallback(async (sessionId) => {
    if (!sessionId) {
      setConversation([]);
      assistantMessageIdRef.current = null;
      return;
    }

    setLoadingConversation(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}`);
      if (!response.ok) {
        throw new Error(`Failed to load session ${sessionId} (${response.status})`);
      }

      const data = await response.json();
      setConversation(Array.isArray(data.messages) ? data.messages : []);
    } catch (error) {
      console.error('Failed to load session', error);
      setConversation([]);
    } finally {
      assistantMessageIdRef.current = null;
      setLoadingConversation(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const appendToolActivity = useCallback((entry) => {
    if (!entry) {
      return;
    }

    setToolActivity((prev) => {
      const next = [...prev, entry];
      const MAX_ENTRIES = 8;
      if (next.length > MAX_ENTRIES) {
        next.splice(0, next.length - MAX_ENTRIES);
      }
      return next;
    });
  }, []);

  const updateAssistantMessage = useCallback((updater) => {
    const assistantId = assistantMessageIdRef.current;
    if (!assistantId) {
      return;
    }

    setConversation((prev) =>
      prev.map((message) => {
        if (message.id !== assistantId) {
          return message;
        }

        return updater(message);
      })
    );
  }, []);

  const handleStream = useCallback(
    async (body) => {
      if (streamControllerRef.current) {
        streamControllerRef.current.abort();
      }

      const controller = new AbortController();
      streamControllerRef.current = controller;

      let refreshAfterStream = false;
      let targetSessionId = activeSessionIdRef.current;

      try {
        setIsStreaming(true);
        setStatusText('Connecting to Claude…');

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok || !response.body) {
          throw new Error(`Claude backend responded with ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        setStatusText('Streaming response…');

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const event = parseSseBlock(chunk);

            if (event) {
              switch (event.event) {
                case 'started': {
                  const backendSessionId = event.data?.sessionId;
                  if (backendSessionId) {
                    pendingSessionIdRef.current = backendSessionId;
                    targetSessionId = backendSessionId;
                    setActiveSessionId(backendSessionId);
                  }
                  break;
                }
                case 'chunk': {
                  const fragment = extractTextFragment(event.data);
                  if (fragment) {
                    updateAssistantMessage((message) => ({
                      ...message,
                      content: `${message.content}${fragment}`
                    }));
                  }

                  const toolEntry = describeToolEvent(event.data);
                  if (toolEntry) {
                    appendToolActivity(toolEntry);
                  }
                  break;
                }
                case 'stderr':
                  if (event.data?.chunk) {
                    appendToolActivity(event.data.chunk.trim());
                  }
                  break;
                case 'raw':
                  if (event.data?.line) {
                    appendToolActivity(`RAW: ${event.data.line}`);
                  }
                  break;
                case 'session':
                  if (event.data?.claudeSessionId) {
                    appendToolActivity(`Linked CLI session ${event.data.claudeSessionId}`);
                  }
                  break;
                case 'error':
                  updateAssistantMessage((message) => ({
                    ...message,
                    content: `${message.content}\n[Error] ${event.data?.message ?? 'Unknown error'}`
                  }));
                  refreshAfterStream = true;
                  break;
                case 'complete':
                  setStatusText('Idle');
                  refreshAfterStream = true;
                  break;
                default:
                  break;
              }
            }

            boundary = buffer.indexOf('\n\n');
          }
        }

        if (refreshAfterStream) {
          const sessionToRefresh = targetSessionId || pendingSessionIdRef.current || activeSessionIdRef.current;
          await loadSessions();
          if (sessionToRefresh) {
            await loadSession(sessionToRefresh);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          updateAssistantMessage((message) => ({
            ...message,
            content: `${message.content}\n[Stream cancelled]`
          }));
        } else {
          updateAssistantMessage((message) => ({
            ...message,
            content: `${message.content}\n[Streaming error] ${error.message}`
          }));
          setStatusText('Errored');
          await loadSessions();
          const fallbackSession = pendingSessionIdRef.current || activeSessionIdRef.current;
          if (fallbackSession) {
            await loadSession(fallbackSession);
          }
        }
      } finally {
        if (streamControllerRef.current === controller) {
          streamControllerRef.current = null;
        }
        setIsStreaming(false);
        setStatusText((current) => (current === 'Errored' ? current : 'Idle'));
        pendingSessionIdRef.current = null;
      }
    },
    [appendToolActivity, loadSession, loadSessions, updateAssistantMessage]
  );

  const sendMessage = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) {
      return;
    }

    if (streamControllerRef.current) {
      streamControllerRef.current.abort();
    }

    const userMessage = {
      id: allocateId(),
      role: 'user',
      content: trimmed
    };

    const assistantMessage = {
      id: allocateId(),
      role: 'assistant',
      content: ''
    };

    assistantMessageIdRef.current = assistantMessage.id;

    setConversation((prev) => [...prev, userMessage, assistantMessage]);
    setInputValue('');
    setStatusText('Queued…');
    setToolActivity([]);

    await handleStream({
      message: trimmed,
      sessionId: activeSessionIdRef.current ?? undefined
    });
  }, [allocateId, handleStream, inputValue, isStreaming]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      await sendMessage();
    },
    [sendMessage]
  );

  const handleKeyDown = useCallback(
    async (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        await sendMessage();
      }
    },
    [sendMessage]
  );

  const handleSelectSession = useCallback(
    async (sessionId) => {
      if (isStreaming && streamControllerRef.current) {
        streamControllerRef.current.abort();
      }

      setActiveSessionId(sessionId);
      await loadSession(sessionId);
      setToolActivity([]);
    },
    [isStreaming, loadSession]
  );

  const handleCreateSession = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`Failed to create session (${response.status})`);
      }

      const session = await response.json();
      setActiveSessionId(session.id);
      setConversation(Array.isArray(session.messages) ? session.messages : []);
      setToolActivity([]);
      assistantMessageIdRef.current = null;
      await loadSessions();
    } catch (error) {
      console.error('Failed to create session', error);
    }
  }, [loadSessions]);

  const launchTerminalSession = useCallback(async () => {
    try {
      const response = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        console.error('Failed to start terminal session');
        return;
      }

      const data = await response.json();
      setTerminalSessionId(data.sessionId);
    } catch (error) {
      console.error('Error launching terminal:', error);
    }
  }, []);

  const actionLabel = useMemo(() => {
    if (isStreaming) {
      return 'Streaming…';
    }

    if (!inputValue.trim()) {
      return 'Enter a prompt';
    }

    return 'Send to Claude';
  }, [inputValue, isStreaming]);

  return (
    <div className="layout">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        isLoading={loadingSessions}
      />
      <div className="main-pane">
        <header className="app-header">
          <div>
            <h2>Claude Code</h2>
            <span className="badge">{activeSessionId ? `Session ${activeSessionId}` : 'New Session'}</span>
          </div>
          <div className="status-pill">{statusText}</div>
        </header>

        <main className="chat-area" ref={chatAreaRef}>
          {loadingConversation ? (
            <div className="empty-state">Loading conversation…</div>
          ) : conversation.length === 0 ? (
            <EmptyState />
          ) : (
            conversation.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
        </main>

        <section className="terminal-wrapper">
          <header>
            <h3>Local Shell</h3>
            <button type="button" onClick={launchTerminalSession}>
              New Terminal Session
            </button>
          </header>
          {terminalSessionId ? (
            <TerminalChat sessionId={terminalSessionId} />
          ) : (
            <p className="terminal-placeholder">Launch a terminal session to see streaming output.</p>
          )}
        </section>

        <div className="composer">
          <form onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              placeholder="Describe what you want Claude to do…"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
            />
            <button type="submit" disabled={isStreaming || !inputValue.trim()}>
              {actionLabel}
            </button>
          </form>
          {toolActivity.length > 0 && (
            <div className="tool-activity">
              <strong>Tool activity</strong>
              <div>
                {toolActivity.map((entry, index) => (
                  <div key={`${entry}-${index}`}>{entry}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
