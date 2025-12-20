import { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { createTwoFilesPatch } from 'diff';

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

// Regex to match file:line patterns (e.g., /path/to/file.js:42)
const FILE_LINE_REGEX = /([\/\w\-\.]+\.[a-zA-Z0-9]+):(\d+)/g;

// File link component
function FileLink({ path, line, onClick }) {
  const handleClick = (e) => {
    e.preventDefault();
    if (onClick) onClick(path, line);
  };

  return (
    <button
      className="file-link"
      onClick={handleClick}
      title={`${path} at line ${line}`}
    >
      {path}:{line}
    </button>
  );
}

// Parse text and replace file:line patterns with clickable links
function parseFileLinks(text, onClick) {
  if (!text || !onClick) return text;

  const parts = [];
  let lastIndex = 0;
  let match;

  // Reset regex state
  FILE_LINE_REGEX.lastIndex = 0;

  while ((match = FILE_LINE_REGEX.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    // The file link
    parts.push(
      <FileLink
        key={`${match.index}-${match[1]}`}
        path={match[1]}
        line={parseInt(match[2], 10)}
        onClick={onClick}
      />
    );
    lastIndex = FILE_LINE_REGEX.lastIndex;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

// Copy button component
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  // Clear timeout on unmount to prevent memory leak
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? '✓' : '⧉'}
    </button>
  );
}

// Diff view component for Edit tool - memoized for performance
function DiffView({ oldString, newString, filePath }) {
  // Memoize expensive diff computation
  const diffLines = useMemo(() => {
    if (!oldString || !newString) return null;

    const patch = createTwoFilesPatch(filePath, filePath, oldString, newString, '', '', { context: 3 });
    return patch.split('\n').slice(4); // Skip the header lines
  }, [oldString, newString, filePath]);

  if (!diffLines) return null;

  if (diffLines.length === 0) {
    return <div className="diff-view"><div className="diff-context">No changes</div></div>;
  }

  return (
    <div className="diff-view">
      {diffLines.map((line, i) => {
        let className = 'diff-context';
        if (line.startsWith('+')) className = 'diff-add';
        else if (line.startsWith('-')) className = 'diff-remove';
        else if (line.startsWith('@')) className = 'diff-header';

        return (
          <div key={i} className={className}>
            <span className="diff-line-content">{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

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
      return { type: 'path', value: input.file_path || input.path || '', oldString: input.old_string, newString: input.new_string };
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
    case 'glob':
    case 'grep':
      return `Found ${lines.toLocaleString()} matches`;
    default:
      // Show actual output for bash and other tools
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

// Custom code block renderer with syntax highlighting and copy button
function CodeBlock({ node, inline, className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '');
  const codeString = String(children).replace(/\n$/, '');

  if (!inline && (match || codeString.includes('\n'))) {
    const language = match ? match[1] : 'text';
    return (
      <div className="code-block-wrapper">
        <CopyButton text={codeString} />
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          customStyle={{
            margin: 0,
            borderRadius: '4px',
            fontSize: '0.85rem',
          }}
          {...props}
        >
          {codeString}
        </SyntaxHighlighter>
      </div>
    );
  }

  return <code className="inline-code" {...props}>{children}</code>;
}

// Markdown renderer component
function MarkdownContent({ content }) {
  if (!content) return null;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        // Style links
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" className="md-link" />
        ),
        // Style tables
        table: ({ node, ...props }) => (
          <div className="md-table-wrapper">
            <table className="md-table" {...props} />
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function ToolCallBlock({ item, onFileClick }) {
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(true);

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

  // Assistant message - with bullet prefix and full markdown
  if (item.type === 'assistant') {
    return (
      <div className="cc-assistant-message">
        <span className="cc-bullet" style={{ color: '#a855f7' }}>●</span>
        <div className="cc-assistant-content">
          <MarkdownContent content={item.content} />
        </div>
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
      <div className={`cc-system-message ${item.isError ? 'error' : ''}`}>
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

    // Check if this is an Edit tool with diff data
    const isEditTool = tool === 'edit';
    const hasDiffData = isEditTool && toolInput.oldString && toolInput.newString;

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
          {hasDiffData && (
            <button
              className="cc-toggle-diff"
              onClick={() => setShowDiff(!showDiff)}
            >
              {showDiff ? 'Hide diff' : 'Show diff'}
            </button>
          )}
        </div>

        {/* Diff view for Edit tool */}
        {hasDiffData && showDiff && (
          <div className="cc-tool-output-container">
            <span className="cc-tree-connector">├─</span>
            <DiffView
              oldString={toolInput.oldString}
              newString={toolInput.newString}
              filePath={toolInput.value}
            />
          </div>
        )}

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
                    <div key={idx} className="cc-output-line">
                      {onFileClick ? parseFileLinks(line, onFileClick) : line || ' '}
                    </div>
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
