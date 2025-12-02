import { useState } from 'react';

// Tool type to color mapping (bullet colors)
const TOOL_COLORS = {
  bash: '#22c55e',      // green
  read: '#3b82f6',      // blue
  write: '#f59e0b',     // orange
  edit: '#f59e0b',      // orange
  glob: '#8b5cf6',      // purple
  grep: '#8b5cf6',      // purple
  task: '#06b6d4',      // cyan
  todowrite: '#ec4899', // pink
  webfetch: '#0ea5e9',  // sky blue
  websearch: '#0ea5e9', // sky blue
  default: '#6b7280'    // gray
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

// Get a summary of tool output (like "Read 222 lines")
function getOutputSummary(tool, output) {
  if (!output) return null;

  const lines = output.split('\n').length;
  const toolLower = tool?.toLowerCase();

  switch (toolLower) {
    case 'read':
      return `Read ${lines.toLocaleString()} lines`;
    case 'bash':
      return lines > 3 ? null : null; // Show actual output for bash
    case 'glob':
    case 'grep':
      return `Found ${lines.toLocaleString()} matches`;
    default:
      return null;
  }
}

function truncateOutput(output, maxLines = 3) {
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

  // User message - in a card/box like Anthropic
  if (item.type === 'user') {
    return (
      <div className="cc-user-message">
        <div className="cc-user-card">
          {item.content}
        </div>
      </div>
    );
  }

  // Assistant message - with bullet prefix
  if (item.type === 'assistant') {
    return (
      <div className="cc-assistant-message">
        <span className="cc-bullet" style={{ color: '#a855f7' }}>●</span>
        <div className="cc-assistant-content">{renderContent(item.content)}</div>
      </div>
    );
  }

  // Skip result type - it duplicates assistant content
  if (item.type === 'result') {
    return null;
  }

  // System message
  if (item.type === 'system') {
    return (
      <div className="cc-system-message">
        {item.content}
      </div>
    );
  }

  // Tool use block - bullet point style with tree connector
  if (item.type === 'tool_use') {
    const tool = item.tool?.toLowerCase() || 'default';
    const bulletColor = TOOL_COLORS[tool] || TOOL_COLORS.default;

    const toolInput = getToolInput(item);
    const hasResult = !!item.result;
    const isError = item.result?.isError;
    const output = item.result?.toolResult || '';

    // Get summary or truncated output
    const summary = getOutputSummary(item.tool, output);
    const { text: displayOutput, truncated, hiddenLines } = expanded
      ? { text: output, truncated: false, hiddenLines: 0 }
      : truncateOutput(output);

    // Determine status
    const isRunning = !hasResult;

    return (
      <div className="cc-tool-block">
        {/* Tool header line with bullet */}
        <div className="cc-tool-header">
          <span
            className={`cc-bullet ${isRunning ? 'pulsing' : ''} ${isError ? 'error' : ''}`}
            style={{ color: isError ? '#ef4444' : bulletColor }}
          >
            ●
          </span>
          <span className="cc-tool-name" style={{ color: bulletColor }}>
            {capitalizeFirst(item.tool)}
          </span>
          {toolInput.value && (
            <span className="cc-tool-input">
              {toolInput.value.length > 60 ? toolInput.value.slice(0, 60) + '...' : toolInput.value}
            </span>
          )}
        </div>

        {/* Output with tree-style connector */}
        {hasResult && output && (
          <div className="cc-tool-output-container">
            <span className="cc-tree-connector">└─</span>
            <div className="cc-tool-output">
              {summary ? (
                // Show summary for Read, etc.
                <span className="cc-output-summary">{summary}</span>
              ) : (
                // Show actual output for Bash, etc.
                <>
                  {displayOutput.split('\n').map((line, idx) => (
                    <div key={idx} className="cc-output-line">{line || ' '}</div>
                  ))}
                </>
              )}
              {!summary && truncated && (
                <button
                  className="cc-show-more"
                  onClick={() => setExpanded(true)}
                >
                  ... +{hiddenLines} lines
                </button>
              )}
              {!summary && expanded && output.split('\n').length > 3 && (
                <button
                  className="cc-show-more"
                  onClick={() => setExpanded(false)}
                >
                  Show less
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}
