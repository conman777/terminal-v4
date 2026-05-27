import { useState, useEffect, useMemo, memo } from 'react';
import { LightweightMarkdown } from './LightweightMarkdown';

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

// Tool type to color mapping (canonical tokens)
const TOOL_COLORS = {
  bash: 'var(--success)',
  read: 'var(--accent-info)',
  write: 'var(--accent-primary)',
  edit: 'var(--accent-primary)',
  glob: 'var(--accent-secondary)',
  grep: 'var(--accent-secondary)',
  task: 'var(--accent-primary-light)',
  todowrite: 'var(--warning)',
  webfetch: 'var(--accent-info)',
  websearch: 'var(--accent-info)',
  default: 'var(--text-muted)'
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

    if (oldString === newString) return [];

    return [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      ...oldString.split('\n').map((line) => `-${line}`),
      ...newString.split('\n').map((line) => `+${line}`)
    ];
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

// Markdown renderer
const MarkdownContent = memo(function MarkdownContent({ content }) {
  if (!content) return null;

  return (
    <LightweightMarkdown
      content={content}
      linkClassName="md-link"
      renderCodeActions={(code) => <CopyButton text={code} />}
    />
  );
});

const ACTIVITY_GROUPS = [
  {
    id: 'tests',
    label: 'Tests & Build',
    patterns: [
      /\b(?:npm|pnpm|yarn)\s+(?:--prefix\s+\S+\s+)?(?:run\s+)?(?:test|build|frontend:build)\b/i,
      /\b(?:vitest|playwright|pytest|cargo\s+test)\b/i,
      /\b(?:tests?\s+passed|tests?\s+failed|passed|failed)\b/i,
    ],
  },
  {
    id: 'browser',
    label: 'Browser Check',
    patterns: [
      /\b(?:playwright|screenshot|browser|viewport|page)\b/i,
    ],
  },
  {
    id: 'files',
    label: 'Files',
    patterns: [
      /^(?:Read|Edited|Wrote|Opened|Searched)\b/i,
      /\.(?:jsx?|tsx?|css|json|md|rs|py|toml|ya?ml|html)\b/i,
    ],
  },
  {
    id: 'server',
    label: 'Server',
    patterns: [
      /\b(?:server|localhost|127\.0\.0\.1|listen|listening|port|vite)\b/i,
    ],
  },
  {
    id: 'git',
    label: 'Git',
    patterns: [
      /\bgit\s+(?:status|diff|show|add|commit|push|log|branch)\b/i,
      /^(?:Commit|Committed|Pushed)\b/i,
      /\borigin\/?\b/i,
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    patterns: [],
  },
];

const ACTIVITY_ACTION_PATTERNS = [
  /^(?:Ran|Read|Edited|Wrote|Opened|Searched|Commit|Committed|Pushed|Started|Stopped|Installed|Updated)\b/i,
  /\b(?:git|npm|pnpm|yarn|node|curl|ss|rg|cat|sed|cargo|python|pytest|vitest)\s+/i,
  /\b(?:tests?\s+passed|tests?\s+failed|passed|failed)\b/i,
  /\b(?:localhost|127\.0\.0\.1|playwright|screenshot)\b/i,
];

function normalizeActivityLine(line) {
  return String(line || '')
    .replace(/\s*\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)\s*/ig, ' ')
    .split('\n')
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s+/, '')
    .trim();
}

function isActivityLine(line) {
  return ACTIVITY_ACTION_PATTERNS.some((pattern) => pattern.test(line));
}

function truncateActivityLine(line) {
  if (line.length <= 180) return line;
  return `${line.slice(0, 177)}...`;
}

function classifyActivityLine(line) {
  return ACTIVITY_GROUPS.find((group) => (
    group.id !== 'terminal' && group.patterns.some((pattern) => pattern.test(line))
  )) || ACTIVITY_GROUPS[ACTIVITY_GROUPS.length - 1];
}

function buildActivitySummary(content) {
  const rawLines = String(content || '')
    .split('\n')
    .map(normalizeActivityLine)
    .filter(Boolean);

  const seen = new Set();
  const activityLines = [];

  for (const line of rawLines) {
    if (!isActivityLine(line)) continue;
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    activityLines.push(truncateActivityLine(line));
  }

  const sourceLines = activityLines.length > 0
    ? activityLines
    : rawLines.slice(0, 12).map(truncateActivityLine);

  const groupsById = new Map(ACTIVITY_GROUPS.map((group) => [group.id, {
    id: group.id,
    label: group.label,
    items: [],
  }]));

  sourceLines.slice(0, 80).forEach((line) => {
    const group = classifyActivityLine(line);
    groupsById.get(group.id).items.push(line);
  });

  return {
    groups: ACTIVITY_GROUPS
      .map((group) => groupsById.get(group.id))
      .filter((group) => group.items.length > 0),
    rawLines,
    eventCount: sourceLines.length,
    rawCount: rawLines.length,
  };
}

function ActivitySummaryBlock({ content }) {
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [showRaw, setShowRaw] = useState(false);
  const { groups, rawLines, eventCount, rawCount } = useMemo(
    () => buildActivitySummary(content),
    [content]
  );

  const toggleGroup = (groupId) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  return (
    <div className="cc-message cc-activity">
      <div className="cc-activity-card">
        <div className="cc-activity-header">
          <div>
            <div className="cc-activity-title">Activity</div>
            <div className="cc-activity-subtitle">
              {eventCount} terminal events grouped from {rawCount} raw lines.
            </div>
          </div>
          <button
            type="button"
            className="cc-activity-raw-toggle"
            onClick={() => setShowRaw((current) => !current)}
            aria-expanded={showRaw}
          >
            {showRaw ? 'Hide Raw' : 'Raw'}
          </button>
        </div>

        <div className="cc-activity-groups" aria-label="Grouped terminal activity">
          {groups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            const visibleItems = expanded ? group.items : group.items.slice(0, 3);
            const hiddenCount = Math.max(group.items.length - visibleItems.length, 0);

            return (
              <section key={group.id} className="cc-activity-group">
                <button
                  type="button"
                  className="cc-activity-group-header"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={expanded}
                >
                  <span className="cc-activity-group-name">{group.label}</span>
                  <span className="cc-activity-count">{group.items.length}</span>
                </button>
                <div className="cc-activity-items">
                  {visibleItems.map((line, index) => (
                    <div key={`${group.id}-${index}-${line.slice(0, 24)}`} className="cc-activity-item">
                      <span className="cc-activity-dot" aria-hidden="true" />
                      <span className="cc-activity-item-text">{line}</span>
                    </div>
                  ))}
                </div>
                {group.items.length > 3 && (
                  <button
                    type="button"
                    className="cc-activity-more"
                    onClick={() => toggleGroup(group.id)}
                  >
                    {expanded ? 'Show less' : `${hiddenCount} more`}
                  </button>
                )}
              </section>
            );
          })}
        </div>

        {showRaw && (
          <pre className="cc-activity-raw" aria-label="Raw terminal transcript">
            {rawLines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}

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
          <div className="cc-assistant-content">
            <MarkdownContent content={item.content} />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === 'assistant_activity') {
    return <ActivitySummaryBlock content={item.content} />;
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
