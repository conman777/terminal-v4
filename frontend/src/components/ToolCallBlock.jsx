import { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { createTwoFilesPatch } from 'diff';

// Tool icons (emoji-based for simplicity, could use SVG icons)
const TOOL_ICONS = {
  bash: '⚡',
  read: '📄',
  write: '✏️',
  edit: '✏️',
  glob: '🔍',
  grep: '🔍',
  task: '🤖',
  todowrite: '📋',
  webfetch: '🌐',
  websearch: '🔎',
  default: '⚙️'
};

// Tool type to color mapping
const TOOL_COLORS = {
  bash: '#22c55e',
  read: '#3b82f6',
  write: '#f59e0b',
  edit: '#f59e0b',
  glob: '#8b5cf6',
  grep: '#8b5cf6',
  task: '#06b6d4',
  todowrite: '#ec4899',
  webfetch: '#0ea5e9',
  websearch: '#0ea5e9',
  default: '#6b7280'
};

// Regex to match file:line patterns
const FILE_LINE_REGEX = /([\/\w\-\.]+\.[a-zA-Z0-9]+):(\d+)/g;

// File link component
function FileLink({ path, line, onClick }) {
  const handleClick = (e) => {
    e.preventDefault();
    if (onClick) onClick(path, line);
  };

  return (
    <button className="file-link" onClick={handleClick} title={`${path} at line ${line}`}>
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

  FILE_LINE_REGEX.lastIndex = 0;

  while ((match = FILE_LINE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
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

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

// Copy button component
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

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

// Todo List Widget - renders checkboxes like the official UI
function TodoWidget({ todos }) {
  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    return <div className="todo-widget-empty">No todos</div>;
  }

  return (
    <div className="todo-widget">
      {todos.map((todo, index) => (
        <div key={index} className={`todo-item ${todo.status}`}>
          <span className={`todo-checkbox ${todo.status}`}>
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
          </span>
          <span className="todo-content">{todo.content}</span>
        </div>
      ))}
    </div>
  );
}

// Diff view component for Edit tool
function DiffView({ oldString, newString, filePath }) {
  const diffLines = useMemo(() => {
    if (!oldString || !newString) return null;

    const patch = createTwoFilesPatch(filePath, filePath, oldString, newString, '', '', { context: 3 });
    return patch.split('\n').slice(4);
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

function getToolDisplayInfo(item) {
  const input = item.toolInput || {};
  const tool = item.tool?.toLowerCase();

  switch (tool) {
    case 'bash':
      return {
        title: 'Bash',
        subtitle: input.command || input.cmd || '',
        icon: TOOL_ICONS.bash
      };
    case 'read':
      return {
        title: 'Read',
        subtitle: input.file_path || input.path || '',
        icon: TOOL_ICONS.read
      };
    case 'write':
      return {
        title: 'Write',
        subtitle: input.file_path || input.path || '',
        icon: TOOL_ICONS.write
      };
    case 'edit':
      return {
        title: 'Edit',
        subtitle: input.file_path || input.path || '',
        icon: TOOL_ICONS.edit,
        oldString: input.old_string,
        newString: input.new_string
      };
    case 'glob':
      return {
        title: 'Glob',
        subtitle: input.pattern || '',
        icon: TOOL_ICONS.glob
      };
    case 'grep':
      return {
        title: 'Grep',
        subtitle: input.pattern || '',
        icon: TOOL_ICONS.grep
      };
    case 'task':
      return {
        title: 'Task',
        subtitle: input.description || input.prompt || '',
        icon: TOOL_ICONS.task
      };
    case 'todowrite':
      return {
        title: 'Update Todos',
        subtitle: '',
        icon: TOOL_ICONS.todowrite,
        todos: input.todos
      };
    case 'webfetch':
      return {
        title: 'WebFetch',
        subtitle: input.url || '',
        icon: TOOL_ICONS.webfetch
      };
    case 'websearch':
      return {
        title: 'WebSearch',
        subtitle: input.query || '',
        icon: TOOL_ICONS.websearch
      };
    default:
      return {
        title: item.tool || 'Tool',
        subtitle: JSON.stringify(input).slice(0, 80),
        icon: TOOL_ICONS.default
      };
  }
}

// Get output summary
function getOutputSummary(tool, output) {
  if (!output) return null;

  const lines = output.split('\n').length;
  const toolLower = tool?.toLowerCase();

  switch (toolLower) {
    case 'read':
      return `Read ${lines.toLocaleString()} lines`;
    case 'glob':
      return `Found ${lines.toLocaleString()} files`;
    case 'grep':
      return `Found ${lines.toLocaleString()} matches`;
    default:
      return null;
  }
}

// Custom code block renderer
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
            borderRadius: '6px',
            fontSize: '0.8125rem',
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

// Markdown renderer
function MarkdownContent({ content }) {
  if (!content) return null;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" className="md-link" />
        ),
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

  // User message - centered card
  if (item.type === 'user') {
    return (
      <div className="cc-message cc-user">
        <div className="cc-user-bubble">
          {item.content}
        </div>
      </div>
    );
  }

  // Assistant message - left aligned with markdown
  if (item.type === 'assistant') {
    return (
      <div className="cc-message cc-assistant">
        <div className="cc-assistant-bubble">
          <MarkdownContent content={item.content} />
        </div>
      </div>
    );
  }

  // Skip result type
  if (item.type === 'result') {
    return null;
  }

  // System message
  if (item.type === 'system') {
    return (
      <div className={`cc-message cc-system ${item.isError ? 'error' : ''}`}>
        {item.content}
      </div>
    );
  }

  // Tool use block - card style
  if (item.type === 'tool_use') {
    const tool = item.tool?.toLowerCase() || 'default';
    const toolColor = TOOL_COLORS[tool] || TOOL_COLORS.default;
    const displayInfo = getToolDisplayInfo(item);

    const hasResult = !!item.result;
    const isError = item.result?.isError;
    const output = item.result?.toolResult || '';
    const isRunning = !hasResult;

    // Special handling for TodoWrite
    if (tool === 'todowrite' && displayInfo.todos) {
      return (
        <div className="cc-message cc-tool-card">
          <div className="cc-tool-card-header" style={{ borderLeftColor: toolColor }}>
            <span className={`cc-tool-status ${isRunning ? 'running' : isError ? 'error' : 'success'}`}>
              {isRunning ? '◐' : isError ? '✕' : '●'}
            </span>
            <span className="cc-tool-title">{displayInfo.title}</span>
          </div>
          <div className="cc-tool-card-body">
            <TodoWidget todos={displayInfo.todos} />
          </div>
        </div>
      );
    }

    // Edit tool with diff
    const isEditTool = tool === 'edit';
    const hasDiffData = isEditTool && displayInfo.oldString && displayInfo.newString;

    // Output handling
    const summary = getOutputSummary(item.tool, output);
    const outputLines = output.split('\n');
    const maxLines = 8;
    const shouldTruncate = outputLines.length > maxLines && !expanded;
    const displayLines = shouldTruncate ? outputLines.slice(0, maxLines) : outputLines;

    return (
      <div className="cc-message cc-tool-card">
        <div className="cc-tool-card-header" style={{ borderLeftColor: toolColor }}>
          <span className={`cc-tool-status ${isRunning ? 'running' : isError ? 'error' : 'success'}`}>
            {isRunning ? '◐' : isError ? '✕' : '●'}
          </span>
          <span className="cc-tool-title">{displayInfo.title}</span>
          {displayInfo.subtitle && (
            <span className="cc-tool-subtitle">
              {displayInfo.subtitle.length > 60
                ? displayInfo.subtitle.slice(0, 60) + '...'
                : displayInfo.subtitle}
            </span>
          )}
          {hasDiffData && (
            <button className="cc-tool-toggle" onClick={() => setShowDiff(!showDiff)}>
              {showDiff ? 'Hide diff' : 'Show diff'}
            </button>
          )}
        </div>

        {/* Diff view for Edit */}
        {hasDiffData && showDiff && (
          <div className="cc-tool-card-body">
            <DiffView
              oldString={displayInfo.oldString}
              newString={displayInfo.newString}
              filePath={displayInfo.subtitle}
            />
          </div>
        )}

        {/* Output */}
        {hasResult && output && (
          <div className="cc-tool-card-body">
            {summary ? (
              <div className="cc-tool-summary">{summary}</div>
            ) : (
              <div className="cc-tool-output">
                {displayLines.map((line, idx) => (
                  <div key={idx} className="cc-output-line">
                    {onFileClick ? parseFileLinks(line, onFileClick) : line || ' '}
                  </div>
                ))}
                {shouldTruncate && (
                  <button className="cc-expand-btn" onClick={() => setExpanded(true)}>
                    Show {outputLines.length - maxLines} more lines
                  </button>
                )}
                {expanded && outputLines.length > maxLines && (
                  <button className="cc-expand-btn" onClick={() => setExpanded(false)}>
                    Show less
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error message */}
        {isError && (
          <div className="cc-tool-card-body cc-tool-error">
            {output || 'Tool execution failed'}
          </div>
        )}
      </div>
    );
  }

  return null;
}
