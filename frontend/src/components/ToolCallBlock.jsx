import { useState } from 'react';

// SVG Icons for each tool type (matching Anthropic's style)
const ToolIcons = {
  bash: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  ),
  read: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
    </svg>
  ),
  write: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  ),
  edit: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  ),
  glob: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  ),
  grep: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      <line x1="8" y1="11" x2="14" y2="11"></line>
    </svg>
  ),
  task: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
  ),
  todowrite: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"></line>
      <line x1="8" y1="12" x2="21" y2="12"></line>
      <line x1="8" y1="18" x2="21" y2="18"></line>
      <line x1="3" y1="6" x2="3.01" y2="6"></line>
      <line x1="3" y1="12" x2="3.01" y2="12"></line>
      <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>
  ),
  webfetch: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
    </svg>
  ),
  websearch: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
    </svg>
  ),
  default: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  )
};

// Tool type to color mapping
const TOOL_COLORS = {
  bash: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.3)', text: '#22c55e' },
  read: { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.3)', text: '#3b82f6' },
  write: { bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.3)', text: '#f59e0b' },
  edit: { bg: 'rgba(245, 158, 11, 0.15)', border: 'rgba(245, 158, 11, 0.3)', text: '#f59e0b' },
  glob: { bg: 'rgba(139, 92, 246, 0.15)', border: 'rgba(139, 92, 246, 0.3)', text: '#8b5cf6' },
  grep: { bg: 'rgba(139, 92, 246, 0.15)', border: 'rgba(139, 92, 246, 0.3)', text: '#8b5cf6' },
  task: { bg: 'rgba(6, 182, 212, 0.15)', border: 'rgba(6, 182, 212, 0.3)', text: '#06b6d4' },
  todowrite: { bg: 'rgba(236, 72, 153, 0.15)', border: 'rgba(236, 72, 153, 0.3)', text: '#ec4899' },
  webfetch: { bg: 'rgba(14, 165, 233, 0.15)', border: 'rgba(14, 165, 233, 0.3)', text: '#0ea5e9' },
  websearch: { bg: 'rgba(14, 165, 233, 0.15)', border: 'rgba(14, 165, 233, 0.3)', text: '#0ea5e9' },
  default: { bg: 'rgba(107, 114, 128, 0.15)', border: 'rgba(107, 114, 128, 0.3)', text: '#6b7280' }
};

// Status icons
const StatusIcons = {
  running: (
    <svg className="status-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25"></circle>
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"></path>
    </svg>
  ),
  success: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  ),
  error: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  )
};

function getToolInput(item) {
  const input = item.toolInput || {};
  const tool = item.tool?.toLowerCase();

  switch (tool) {
    case 'bash':
      return { type: 'command', value: input.command || input.cmd || '' };
    case 'read':
      return { type: 'path', value: input.file_path || input.path || '' };
    case 'write':
      return { type: 'path', value: input.file_path || input.path || '' };
    case 'edit':
      return { type: 'path', value: input.file_path || input.path || '' };
    case 'glob':
      return { type: 'pattern', value: input.pattern || '' };
    case 'grep':
      return { type: 'pattern', value: input.pattern || '' };
    case 'task':
      return { type: 'description', value: input.description || input.prompt || '' };
    case 'todowrite':
      const todos = input.todos || [];
      return { type: 'todos', value: `${todos.length} todo${todos.length !== 1 ? 's' : ''}` };
    case 'webfetch':
      return { type: 'url', value: input.url || '' };
    case 'websearch':
      return { type: 'query', value: input.query || '' };
    default:
      return { type: 'json', value: JSON.stringify(input).slice(0, 100) };
  }
}

function getOutputStats(output) {
  if (!output) return null;

  const lines = output.split('\n');
  const lineCount = lines.length;
  const charCount = output.length;

  if (lineCount > 10) {
    return `${lineCount} lines`;
  } else if (charCount > 200) {
    return `${charCount} chars`;
  }
  return null;
}

function truncateOutput(output, maxLines = 15) {
  if (!output) return { text: '', truncated: false, hiddenLines: 0 };

  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return { text: output, truncated: false, hiddenLines: 0 };
  }

  const visibleLines = lines.slice(0, maxLines);
  return {
    text: visibleLines.join('\n'),
    truncated: true,
    hiddenLines: lines.length - maxLines
  };
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Simple markdown-like rendering for assistant messages
function renderContent(content) {
  if (!content) return null;

  // Split by code blocks first
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    // Code block
    if (part.startsWith('```')) {
      const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
      if (match) {
        const [, lang, code] = match;
        return (
          <pre key={i} className="code-block" data-lang={lang || 'text'}>
            <code>{code.trim()}</code>
          </pre>
        );
      }
    }

    // Inline code
    const inlineCodeParts = part.split(/(`[^`]+`)/g);
    return (
      <span key={i}>
        {inlineCodeParts.map((p, j) => {
          if (p.startsWith('`') && p.endsWith('`')) {
            return <code key={j} className="inline-code">{p.slice(1, -1)}</code>;
          }
          return p;
        })}
      </span>
    );
  });
}

export default function ToolCallBlock({ item }) {
  const [expanded, setExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);

  // User message
  if (item.type === 'user') {
    return (
      <div className="claude-message user-message">
        <div className="message-content">{item.content}</div>
      </div>
    );
  }

  // Assistant message
  if (item.type === 'assistant' || item.type === 'result') {
    return (
      <div className="claude-message assistant-message">
        <div className="message-content">{renderContent(item.content)}</div>
      </div>
    );
  }

  // System message
  if (item.type === 'system') {
    return (
      <div className="claude-message system-message">
        <div className="message-content">{item.content}</div>
      </div>
    );
  }

  // Tool use block
  if (item.type === 'tool_use') {
    const tool = item.tool?.toLowerCase() || 'default';
    const colors = TOOL_COLORS[tool] || TOOL_COLORS.default;
    const icon = ToolIcons[tool] || ToolIcons.default;

    const toolInput = getToolInput(item);
    const hasResult = !!item.result;
    const isError = item.result?.isError;
    const output = item.result?.toolResult || '';
    const outputStats = getOutputStats(output);

    const { text: displayOutput, truncated, hiddenLines } = showFullOutput
      ? { text: output, truncated: false, hiddenLines: 0 }
      : truncateOutput(output);

    // Determine status
    let status = 'running';
    if (hasResult) {
      status = isError ? 'error' : 'success';
    }

    return (
      <div className="tool-block" style={{ '--tool-color': colors.text }}>
        <div
          className="tool-block-header"
          onClick={() => hasResult && setExpanded(!expanded)}
          style={{
            backgroundColor: colors.bg,
            borderColor: colors.border,
            cursor: hasResult ? 'pointer' : 'default'
          }}
        >
          <span className="tool-block-icon" style={{ color: colors.text }}>
            {icon}
          </span>
          <span className="tool-block-name">{capitalizeFirst(item.tool)}</span>

          {toolInput.value && (
            <span className="tool-block-input" title={toolInput.value}>
              {toolInput.value.length > 60 ? toolInput.value.slice(0, 60) + '...' : toolInput.value}
            </span>
          )}

          <span className="tool-block-spacer" />

          {outputStats && hasResult && (
            <span className="tool-block-stats">{outputStats}</span>
          )}

          <span className={`tool-block-status ${status}`}>
            {StatusIcons[status]}
          </span>

          {hasResult && (
            <span className="tool-block-chevron">
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </div>

        {expanded && hasResult && (
          <div className="tool-block-output">
            <pre>{displayOutput}</pre>
            {truncated && (
              <button
                className="show-more-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFullOutput(true);
                }}
              >
                ... +{hiddenLines} more lines
              </button>
            )}
            {showFullOutput && output.split('\n').length > 15 && (
              <button
                className="show-more-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFullOutput(false);
                }}
              >
                Show less
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}
