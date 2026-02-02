import { useState, useEffect, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createTwoFilesPatch } from 'diff';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';

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
const FileLink = memo(function FileLink({ path, line, onClick }) {
  const handleClick = (e) => {
    e.preventDefault();
    if (onClick) onClick(path, line);
  };

  return (
    <button className="file-link" onClick={handleClick} title={`${path} at line ${line}`}>
      {path}:{line}
    </button>
  );
});

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
const CopyButton = memo(function CopyButton({ text }) {
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
});

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

// Generate tool summary for collapsed view
function generateToolSummary(tool, input, output, isError) {
  const toolLower = tool?.toLowerCase();

  if (isError) {
    return 'Error';
  }

  if (!output) {
    return 'Running...';
  }

  const lines = output.split('\n').filter(l => l.trim()).length;
  const chars = output.length;

  switch (toolLower) {
    case 'read':
      return `${lines.toLocaleString()} lines`;
    case 'write':
      return `${lines.toLocaleString()} lines written`;
    case 'edit':
      return 'Applied';
    case 'bash': {
      const exitMatch = output.match(/exit code[:\s]*(\d+)/i);
      if (exitMatch && exitMatch[1] !== '0') {
        return `Exit ${exitMatch[1]}`;
      }
      return lines > 0 ? `${lines} lines` : 'Done';
    }
    case 'glob':
      return `${lines.toLocaleString()} files`;
    case 'grep':
      return `${lines.toLocaleString()} matches`;
    case 'task':
      return 'Completed';
    case 'todowrite':
      const todoCount = input?.todos?.length || 0;
      return `${todoCount} items`;
    case 'webfetch':
      return chars > 0 ? `${Math.round(chars / 1024)}KB` : 'Fetched';
    case 'websearch':
      return lines > 0 ? `${lines} results` : 'Searched';
    default:
      return lines > 0 ? `${lines} lines` : 'Done';
  }
}

// Custom code block renderer
const CodeBlock = memo(function CodeBlock({ node, inline, className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '');
  const codeString = String(children).replace(/\n$/, '');

  if (!inline && (match || codeString.includes('\n'))) {
    const language = match ? match[1] : 'text';
    return (
      <div className="code-block-wrapper">
        <CopyButton text={codeString} />
        <LazySyntaxHighlighter
          language={language}
          customStyle={{
            margin: 0,
            borderRadius: '6px',
            fontSize: '0.8125rem',
          }}
          {...props}
        >
          {codeString}
        </LazySyntaxHighlighter>
      </div>
    );
  }

  return <code className="inline-code" {...props}>{children}</code>;
});

// Markdown renderer
const MarkdownContent = memo(function MarkdownContent({ content }) {
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
});

export default memo(function ToolCallBlock({ item, onFileClick }) {
  // Default to collapsed for tool blocks
  const [expanded, setExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);

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

  // Tool use block - compact collapsed style
  if (item.type === 'tool_use') {
    const tool = item.tool?.toLowerCase() || 'default';
    const toolColor = TOOL_COLORS[tool] || TOOL_COLORS.default;
    const displayInfo = getToolDisplayInfo(item);

    const hasResult = !!item.result;
    const isError = item.result?.isError;
    const output = item.result?.toolResult || '';
    const isRunning = !hasResult;

    // Generate summary for the header
    const summary = generateToolSummary(item.tool, item.toolInput, output, isError);

    // Special handling for TodoWrite - always show expanded
    if (tool === 'todowrite' && displayInfo.todos) {
      return (
        <div className="cc-message cc-tool-compact">
          <div
            className={`cc-tool-header ${expanded ? 'expanded' : ''}`}
            style={{ '--tool-color': toolColor }}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="cc-tool-expand">{expanded ? '▼' : '▶'}</span>
            <span className="cc-tool-icon">{displayInfo.icon}</span>
            <span className="cc-tool-name">{displayInfo.title}</span>
            <span className="cc-tool-summary">{summary}</span>
            <span className={`cc-tool-status-icon ${isRunning ? 'running' : isError ? 'error' : 'success'}`}>
              {isRunning ? '⟳' : isError ? '✕' : '✓'}
            </span>
          </div>
          {expanded && (
            <div className="cc-tool-body">
              <TodoWidget todos={displayInfo.todos} />
            </div>
          )}
        </div>
      );
    }

    // Edit tool with diff
    const isEditTool = tool === 'edit';
    const hasDiffData = isEditTool && displayInfo.oldString && displayInfo.newString;

    // Output handling for expanded view
    const outputLines = output ? output.split('\n') : [];
    const maxInitialLines = 10;
    const hasMoreOutput = outputLines.length > maxInitialLines;
    const displayLines = showFullOutput ? outputLines : outputLines.slice(0, maxInitialLines);

    // Truncate subtitle for display
    const shortSubtitle = displayInfo.subtitle
      ? (displayInfo.subtitle.length > 40
          ? '...' + displayInfo.subtitle.slice(-37)
          : displayInfo.subtitle)
      : '';

    return (
      <div className={`cc-message cc-tool-compact ${isError ? 'error' : ''}`}>
        <div
          className={`cc-tool-header ${expanded ? 'expanded' : ''}`}
          style={{ '--tool-color': toolColor }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="cc-tool-expand">{expanded ? '▼' : '▶'}</span>
          <span className="cc-tool-icon">{displayInfo.icon}</span>
          <span className="cc-tool-name">{displayInfo.title}</span>
          {shortSubtitle && <span className="cc-tool-path">{shortSubtitle}</span>}
          <span className="cc-tool-summary">{summary}</span>
          <span className={`cc-tool-status-icon ${isRunning ? 'running' : isError ? 'error' : 'success'}`}>
            {isRunning ? '⟳' : isError ? '✕' : '✓'}
          </span>
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="cc-tool-body">
            {/* Diff view for Edit */}
            {hasDiffData && (
              <DiffView
                oldString={displayInfo.oldString}
                newString={displayInfo.newString}
                filePath={displayInfo.subtitle}
              />
            )}

            {/* Output */}
            {hasResult && output && !hasDiffData && (
              <div className="cc-tool-output">
                {displayLines.map((line, idx) => (
                  <div key={idx} className="cc-output-line">
                    {onFileClick ? parseFileLinks(line, onFileClick) : line || ' '}
                  </div>
                ))}
                {hasMoreOutput && !showFullOutput && (
                  <button className="cc-show-more-btn" onClick={(e) => { e.stopPropagation(); setShowFullOutput(true); }}>
                    Show {outputLines.length - maxInitialLines} more lines
                  </button>
                )}
                {showFullOutput && hasMoreOutput && (
                  <button className="cc-show-more-btn" onClick={(e) => { e.stopPropagation(); setShowFullOutput(false); }}>
                    Show less
                  </button>
                )}
              </div>
            )}

            {/* Error message */}
            {isError && !output && (
              <div className="cc-tool-error-msg">Tool execution failed</div>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
});
