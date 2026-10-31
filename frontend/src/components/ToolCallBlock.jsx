import { useState, useEffect, useMemo, useId, memo } from 'react';
import { LightweightMarkdown } from './LightweightMarkdown';
import { getBrowserToolDisplayInfo } from '../utils/browserToolPresentation';
import { projectFileReference } from '../utils/projectFileReference';
import './ToolCallBlock.css';

// Regex to match file:line patterns
const FILE_LINE_REGEX = /([\/\w\-\.]+\.[a-zA-Z0-9]+):(\d+)/g;
const PROJECT_FILE_LINE_REGEX = /(?<![\p{L}\p{N}_./\\:%?#@-])((?:\/|\.\/)?[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*:\d+(?::\d+)?)(?![\p{L}\p{N}_./\\:%?#@-])/gu;

// File link component
const FileLink = memo(function FileLink({ path, line, onClick }) {
  const handleClick = (e) => {
    e.preventDefault();
    if (onClick) onClick(path, line);
  };

  return (
    <button type="button" className="file-link" onClick={handleClick} title={`${path} at line ${line}`}>
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

function parseProjectFileLinks(text, workspacePath, onClick) {
  const parts = [];
  let lastIndex = 0;
  for (const match of text.matchAll(PROJECT_FILE_LINE_REGEX)) {
    const file = projectFileReference(match[1], workspacePath);
    if (!file) continue;
    parts.push(text.slice(lastIndex, match.index));
    parts.push(<button type="button" className="file-link" key={match.index}
      aria-label={`Open ${match[1]} at line ${file.line}`} onClick={() => onClick(file)}>{match[1]}</button>);
    lastIndex = match.index + match[1].length;
  }
  if (!parts.length) return text || ' ';
  parts.push(text.slice(lastIndex));
  return parts;
}

// Copy button component
const CopyButton = memo(function CopyButton({ text, label = 'Copy code' }) {
  const [feedback, setFeedback] = useState(null);
  const state = feedback?.text === text ? feedback.state : 'idle';

  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setFeedback(null), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ text, state: 'copied' });
    } catch {
      setFeedback({ text, state: 'failed' });
    }
  };

  return (
    <span className="cc-copy-action">
      <button type="button" className="copy-btn cc-copy-button" onClick={handleCopy} aria-label={label}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className={state === 'failed' ? 'cc-copy-error' : 'cc-copy-feedback'} role="status">
        {state === 'failed' ? 'Could not copy. Try again.' : state === 'copied' ? 'Copied to clipboard' : ''}
      </span>
    </span>
  );
});

// Todo List Widget - renders checkboxes like the official UI
function TodoWidget({ todos }) {
  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    return <div className="todo-widget-empty">No todos</div>;
  }

  return (
    <ul className="todo-widget cc-todo-list">
      {todos.map((todo, index) => (
        <li key={index} className={`todo-item ${todo.status}`}>
          <span className={`todo-checkbox ${todo.status}`} aria-hidden="true">
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
          </span>
          <span className="todo-content">{todo.content}</span>
          <span className="cc-todo-status">{todo.status === 'completed' ? 'Completed' : todo.status === 'in_progress' ? 'In progress' : 'Pending'}</span>
        </li>
      ))}
    </ul>
  );
}

export function sessionTodoResult(output) {
  try {
    const value = JSON.parse(output);
    if (!Array.isArray(value?.todos) || !value.todos.every(todo => typeof todo?.id === 'string' && typeof todo?.content === 'string' && typeof todo?.status === 'string')) return null;
    if (new Set(value.todos.map(todo => todo.id)).size !== value.todos.length) return null;
    return value.todos;
  } catch { return null; }
}

function parallelDelegationResults(output) {
  try {
    const results = JSON.parse(output)?.results;
    if (!Array.isArray(results) || results.length < 1 || results.length > 4 || !results.every(item =>
      (item?.status === 'completed' && typeof item.result === 'string') ||
      (item?.status === 'failed' && typeof item.error === 'string'))) return null;
    return results;
  } catch { return null; }
}

function backgroundDelegationStart(output) {
  try {
    const result = JSON.parse(output);
    return result?.status === 'running' && typeof result.delivery === 'string' ? result : null;
  } catch { return null; }
}

function SessionTodoWidget({ todos }) {
  if (!todos.length) return <div className="cc-session-todo-empty">No tasks yet</div>;
  const byId = new Map(todos.map(todo => [todo.id, todo]));
  const children = new Map();
  for (const todo of todos) {
    let parent = typeof todo.parent === 'string' && byId.has(todo.parent) ? todo.parent : null;
    const visited = new Set([todo.id]);
    for (let cursor = parent; cursor; cursor = byId.get(cursor)?.parent) {
      if (visited.has(cursor)) { parent = null; break; }
      visited.add(cursor);
    }
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(todo);
  }
  const statuses = { pending: ['○', 'Pending'], in_progress: ['◐', 'In progress'], completed: ['✓', 'Completed'], cancelled: ['–', 'Cancelled'] };
  const renderList = (items, root = false) => <ul className="cc-session-todos" aria-label={root ? 'Session tasks' : undefined}>
    {items.map(todo => {
      const [icon, label] = Object.hasOwn(statuses, todo.status) ? statuses[todo.status] : ['○', 'Unknown'];
      return <li key={todo.id}>
        <div className="cc-session-todo-row"><span aria-hidden="true">{icon}</span><span className="cc-session-todo-content">{todo.content}</span><span className="cc-session-todo-status">{label}</span></div>
        {children.has(todo.id) && renderList(children.get(todo.id))}
      </li>;
    })}
  </ul>;
  return renderList(children.get(null) || [], true);
}

// Diff view component for Edit tool
function DiffView({ oldString, newString, filePath }) {
  const diffLines = useMemo(() => {
    if (typeof oldString !== 'string' || typeof newString !== 'string') return null;

    if (oldString === newString) return [];

    return [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      ...(oldString ? oldString.split('\n').map((line) => `-${line}`) : []),
      ...(newString ? newString.split('\n').map((line) => `+${line}`) : [])
    ];
  }, [oldString, newString, filePath]);

  if (!diffLines) return null;

  if (diffLines.length === 0) {
    return <div className="diff-view"><div className="diff-context">No changes</div></div>;
  }

  return (
    <div className="diff-view" tabIndex={0} role="region" aria-label="Proposed changes" data-conversation-scroll-region>
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

const SHELL_WRAPPER_RE = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+([\s\S]+)$/;
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);
const LIST_COMMANDS = new Set(['ls', 'tree', 'fd']);
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'ag']);
const GREP_VALUE_FLAGS = ['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir'];
const VALUE_FLAGS = {
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes'],
  nl: ['-b', '-v', '-i', '-w', '-s', '-n'],
  bat: ['-l', '--language', '-r', '--line-range', '-H', '--highlight-line', '--style', '--theme'],
  rg: ['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context',
    '-e', '--regexp', '-f', '--file', '-M', '--max-columns', '--max-depth', '-j', '--threads', '-E', '--encoding'],
  grep: GREP_VALUE_FLAGS,
  egrep: GREP_VALUE_FLAGS,
  git: GREP_VALUE_FLAGS,
  ag: ['-G', '--file-search-regex', '-A', '-B', '-C', '-m'],
};
const MERGEABLE_KINDS = new Set(['read', 'search', 'list']);

// Codex reports commands as `/bin/zsh -lc '<command>'`; the wrapper is noise for a primary label.
export function unwrapShellCommand(command) {
  const trimmed = String(command || '').trim();
  const body = trimmed.match(SHELL_WRAPPER_RE)?.[1]?.trim();
  if (!body || body.length < 2) return trimmed;
  if (body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'\\''/g, "'");
  if (body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return body;
}

function splitShellSegments(command) {
  if (/\$\(|`|<<|[()]/.test(command)) return null;
  const segments = [{ op: null, tokens: [] }];
  let token = '';
  let hasToken = false;
  let protectedToken = false;
  let quote = null;
  const pushToken = () => {
    if (hasToken) segments[segments.length - 1].tokens.push(token);
    token = '';
    hasToken = false;
    protectedToken = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && ['"', '\\', '$', '`', '\n'].includes(command[i + 1])) {
        const next = command[++i];
        if (next !== '\n') token += next;
      } else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; hasToken = true; protectedToken = true; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      const next = command[++i];
      if (next !== '\n') { token += next; hasToken = true; protectedToken = true; }
      continue;
    }
    if (/\s/.test(ch) && ch !== '\n') { pushToken(); continue; }
    const pair = command.slice(i, i + 2);
    if (ch === '<' || ch === '>') {
      // Only unquoted digits adjacent to a redirect are an IO descriptor.
      if (!protectedToken && /^\d+$/.test(token)) { token = ''; hasToken = false; }
      pushToken();
      const redirect = ['>>', '>&', '>|', '<>', '<&'].includes(pair) ? pair : ch;
      segments[segments.length - 1].tokens.push({ redirect });
      i += redirect.length - 1;
      continue;
    }
    if (pair === '&&' || pair === '||') { pushToken(); segments.push({ op: pair, tokens: [] }); i += 1; continue; }
    if (ch === '&' || ch === '\\') return null;
    if (ch === ';' || ch === '|' || ch === '\n') { pushToken(); segments.push({ op: ch === '\n' ? ';' : ch, tokens: [] }); continue; }
    token += ch;
    hasToken = true;
  }
  if (quote) return null;
  pushToken();
  const stripped = segments.map(segment => ({ ...segment, tokens: stripRedirects(segment.tokens) }));
  if (stripped.some(segment => !segment.tokens)) return null;
  return stripped.filter(segment => segment.tokens.length > 0);
}

// Drops harmless redirects (stderr to stdout, /dev/null); returns null when output is written to a file.
function stripRedirects(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token === 'string') { result.push(token); continue; }
    const target = tokens[++i];
    if (typeof target !== 'string' || !target) return null;
    if (token.redirect === '<') continue;
    if (['>', '>>', '>|'].includes(token.redirect) && target === '/dev/null') continue;
    if (['>&', '<&'].includes(token.redirect) && /^\d+$/.test(target)) continue;
    return null;
  }
  return result;
}

function positionalArgs(args, valueFlags = []) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { values.push(...args.slice(i + 1)); break; }
    if (valueFlags.includes(arg)) { i += 1; continue; }
    if (arg.startsWith('-') && arg !== '-') continue;
    values.push(arg);
  }
  return values;
}

function baseName(path) {
  const trimmed = String(path || '').replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed;
}

function classifyShellSegment(tokens) {
  const words = tokens.slice();
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const program = baseName(words[0]);
  const args = words.slice(1);

  if (READ_COMMANDS.has(program)) {
    const files = positionalArgs(args, VALUE_FLAGS[program]);
    return files.length ? { kind: 'read', files } : null;
  }
  if (program === 'sed') {
    if (args.some(arg => arg.startsWith('-') && arg !== '-n')) return null;
    if (!args.includes('-n')) return null;
    const [script, ...files] = positionalArgs(args);
    const range = script?.match(/^(\d+)(?:,(\d+|\$))?p$/);
    if (!range || files.length === 0) return null;
    return { kind: 'read', files, range: range[2] ? `${range[1]}–${range[2]}` : range[1] };
  }
  if (LIST_COMMANDS.has(program) || (program === 'rg' && args.includes('--files'))
    || (program === 'find' && !args.some(arg => /^-(?:exec|execdir|delete|ok|okdir|fprint|fls)/.test(arg)))) {
    return { kind: 'list' };
  }
  if (SEARCH_COMMANDS.has(program) || (program === 'git' && args[0] === 'grep')) {
    const searchArgs = program === 'git' ? args.slice(1) : args;
    const explicit = searchArgs.findIndex(arg => arg === '-e' || arg === '--regexp');
    const pattern = explicit >= 0 ? searchArgs[explicit + 1] : positionalArgs(searchArgs, VALUE_FLAGS[program])[0];
    return pattern ? { kind: 'search', patterns: [pattern] } : null;
  }
  if (program === 'git') {
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) index += ['-C', '-c'].includes(args[index]) ? 2 : 1;
    const subcommand = args[index];
    return subcommand && /^[a-z][a-z-]*$/.test(subcommand) ? { kind: 'git', subcommand } : null;
  }
  const runner = ['npx', 'pnpx', 'bunx'].includes(program) ? baseName(args[0]) : program;
  const runnerArgs = runner === program ? args : args.slice(1);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(runner)) {
    const filtered = positionalArgs(runnerArgs.filter((arg, i) => arg !== '--prefix' && runnerArgs[i - 1] !== '--prefix'));
    const script = filtered[0] === 'run' ? filtered[1] : filtered[0];
    if (/^test(?:[:-]|$)/.test(script || '')) return { kind: 'test' };
    if (/^build(?:[:-]|$)/.test(script || '')) return { kind: 'build' };
    return null;
  }
  if (['vitest', 'jest', 'pytest'].includes(runner) || (runner === 'playwright' && runnerArgs[0] === 'test')
    || (['cargo', 'go'].includes(runner) && runnerArgs[0] === 'test')) {
    return { kind: 'test' };
  }
  if (runner === 'cargo' && runnerArgs[0] === 'build') return { kind: 'build' };
  return null;
}

const IGNORABLE_PREFIXES = new Set(['cd', 'pwd']);
const OUTPUT_FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'cat', 'less', 'more', 'nl', 'column']);

// Only recognises simple, read-only shapes; anything else stays a neutral "Run command".
export function describeShellCommand(command) {
  const unwrapped = unwrapShellCommand(command);
  const segments = splitShellSegments(unwrapped);
  if (!segments?.length) return null;

  const mains = [];
  segments.forEach((segment, index) => {
    const program = baseName(segment.tokens[0]);
    if (segment.op === '|' && OUTPUT_FILTERS.has(program)) return;
    if (IGNORABLE_PREFIXES.has(program) && segments[index + 1]?.op === '&&') return;
    mains.push(segment);
  });
  if (mains.length === 0 || mains.some(segment => segment.op === '||' || (segment.op === '|' && segment !== mains[0]))) return null;

  const described = mains.map(segment => classifyShellSegment(segment.tokens));
  if (described.some(entry => !entry)) return null;
  if (described.length === 1) return described[0];
  const kind = described[0].kind;
  if (!MERGEABLE_KINDS.has(kind) || described.some(entry => entry.kind !== kind)) return null;
  return {
    kind,
    files: described.flatMap(entry => entry.files || []),
    patterns: described.flatMap(entry => entry.patterns || []),
  };
}

const COMMAND_KIND_TITLES = {
  read: 'Read',
  search: 'Search',
  list: 'List files',
  test: 'Run tests',
  build: 'Build',
};

function describeCommandTool(input) {
  const command = String(input.command || input.cmd || '');
  const unwrapped = unwrapShellCommand(command).replace(/\s+/g, ' ').trim();
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description) return { kind: 'command', title: description, detail: unwrapped };

  const parsed = describeShellCommand(command);
  if (!parsed) return { kind: 'command', title: 'Run command', detail: unwrapped };
  if (parsed.kind === 'read') {
    const names = parsed.files.map(baseName).join(', ');
    return { kind: 'read', count: parsed.files.length, title: 'Read', detail: parsed.range ? `${names} · lines ${parsed.range}` : names };
  }
  if (parsed.kind === 'search') return { kind: 'search', title: 'Search', detail: parsed.patterns.join(', ') };
  if (parsed.kind === 'git') {
    return { kind: 'command', title: `Git ${parsed.subcommand}`, detail: unwrapped };
  }
  return { kind: parsed.kind === 'list' ? 'list' : 'command', title: COMMAND_KIND_TITLES[parsed.kind], detail: unwrapped };
}

function stringifyToolInput(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) return '';
  return JSON.stringify(input, null, 2);
}

export function getToolDisplayInfo(item) {
  const input = item.toolInput || {};
  const tool = item.tool?.toLowerCase();
  const filePath = input.file_path || input.path || '';
  const browserInfo = getBrowserToolDisplayInfo(item.tool, input);
  if (browserInfo) return browserInfo;

  switch (tool) {
    case 'run_command':
    case 'exec_command':
    case 'bash': {
      const command = input.command || input.cmd || '';
      return {
        ...describeCommandTool(input),
        input: command,
        inputLabel: 'Command',
        cwd: typeof input.cwd === 'string' ? input.cwd : ''
      };
    }
    case 'read':
    case 'read_file':
      return { kind: 'read', count: 1, title: 'Read', detail: baseName(filePath), input: filePath, inputLabel: 'Path' };
    case 'write':
    case 'write_file':
      return { kind: 'edit', count: 1, title: 'Write', detail: baseName(filePath), input: filePath, inputLabel: 'Path' };
    case 'edit':
    case 'replace_text':
      return {
        kind: 'edit',
        count: 1,
        title: 'Edit',
        detail: baseName(filePath),
        input: filePath,
        inputLabel: 'Path',
        oldString: input.old_string,
        newString: input.new_string
      };
    case 'edit_files': {
      const paths = (Array.isArray(input.changes) ? input.changes : []).map(change => change?.path).filter(Boolean);
      return {
        kind: 'edit',
        count: Math.max(paths.length, 1),
        title: 'Edit files',
        detail: paths.map(baseName).join(', '),
        input: paths.join('\n'),
        inputLabel: 'Files'
      };
    }
    case 'glob':
    case 'list_files':
      return { kind: 'list', title: 'List files', detail: input.pattern || filePath, input: input.pattern || filePath, inputLabel: 'Pattern' };
    case 'grep':
    case 'search_text':
      return { kind: 'search', title: 'Search', detail: input.pattern || input.text || '', input: stringifyToolInput(input), inputLabel: 'Input' };
    case 'task':
      return { kind: 'other', title: 'Task', detail: input.description || input.prompt || '', input: input.prompt || input.description || '', inputLabel: 'Prompt' };
    case 'delegate_task':
      return { kind: 'other', title: 'Read-only investigation', detail: typeof input.prompt === 'string' ? input.prompt : '', input: typeof input.prompt === 'string' ? input.prompt : '', inputLabel: 'Task' };
    case 'delegate_task_background':
      return { kind: 'other', title: 'Background investigation', detail: typeof input.prompt === 'string' ? input.prompt : '', input: typeof input.prompt === 'string' ? input.prompt : '', inputLabel: 'Task' };
    case 'delegate_tasks': {
      const prompts = Array.isArray(input.prompts) ? input.prompts.filter(prompt => typeof prompt === 'string') : [];
      return { kind: 'other', title: 'Read-only investigations', detail: `${prompts.length} tasks`, input: prompts.join('\n\n'), inputLabel: 'Tasks' };
    }
    case 'todowrite':
      return {
        kind: 'other',
        title: 'Update Todos',
        detail: '',
        todos: input.todos
      };
    case 'todo_list':
      return { kind: 'other', title: 'Task list', detail: '' };
    case 'create_schedule':
      return { kind: 'other', title: 'Create schedule', detail: typeof input.name === 'string' ? input.name : '', input: stringifyToolInput(input), inputLabel: 'Schedule details' };
    case 'list_schedules':
      return { kind: 'other', title: 'List schedules', detail: '' };
    case 'manage_schedule':
      return { kind: 'other', title: 'Manage schedule', detail: [['edit', 'Edit'], ['pause', 'Pause'], ['resume', 'Resume'], ['run', 'Run now'], ['remove', 'Remove']].find(([action]) => action === input.action)?.[1] || '', input: stringifyToolInput(input), inputLabel: 'Schedule action' };
    case 'webfetch':
    case 'web_extract':
      return { kind: 'web', title: 'Fetch page', detail: input.url || '', input: input.url || '', inputLabel: 'URL' };
    case 'websearch':
    case 'web_search':
      return { kind: 'web', title: 'Web search', detail: input.query || '', input: input.query || '', inputLabel: 'Query' };
    default: {
      const full = stringifyToolInput(input);
      return {
        kind: 'other',
        title: item.tool || 'Tool',
        detail: typeof input.description === 'string' ? input.description : filePath,
        input: full,
        inputLabel: 'Input'
      };
    }
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
    case 'delegate_task':
      return 'Completed';
    case 'delegate_tasks': {
      const results = parallelDelegationResults(output);
      if (results) {
        const completed = results.filter(result => result.status === 'completed').length;
        return `${completed} completed, ${results.length - completed} failed`;
      }
      return 'Completed';
    }
    case 'todowrite':
      const todoCount = input?.todos?.length || 0;
      return `${todoCount} items`;
    case 'webfetch':
      return chars > 0 ? `${Math.round(chars / 1024)}KB` : 'Fetched';
    case 'web_extract':
      return 'Fetched';
    case 'websearch':
      return lines > 0 ? `${lines} results` : 'Searched';
    case 'web_search':
      return 'Searched';
    case 'create_schedule':
    case 'list_schedules':
    case 'manage_schedule':
      return 'Done';
    default:
      return lines > 0 ? `${lines} lines` : 'Done';
  }
}

// Markdown renderer
const MarkdownContent = memo(function MarkdownContent({ content, workspacePath, onFileClick }) {
  if (!content) return null;

  return (
    <LightweightMarkdown
      content={content}
      linkClassName="md-link"
      workspacePath={workspacePath}
      onFileClick={onFileClick}
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
  /^(?:git|npm|pnpm|yarn|node|curl|ss|rg|cat|sed|cargo|python|pytest|vitest)\s+/i,
  /\b(?:tests?\s+passed|tests?\s+failed|passed|failed)\b/i,
  /^(?:Opened|Inspected|Captured|Took)\b.*\b(?:localhost|127\.0\.0\.1|playwright|screenshot|browser|viewport|page)\b/i,
];

function normalizeActivityLine(line) {
  return String(line || '')
    .replace(/\s*\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)\s*/ig, ' ')
    .split('\n')
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-*•●]\s+/, '')
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
  const [expanded, setExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [showRaw, setShowRaw] = useState(false);
  const { groups, eventCount } = useMemo(
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
            <div className="cc-activity-title">Terminal activity</div>
            <div className="cc-activity-subtitle">
              {eventCount} events hidden from the main conversation.
            </div>
          </div>
          <div className="cc-activity-actions">
            <button
              type="button"
              className="cc-activity-toggle"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
            >
              {expanded ? 'Hide' : 'Details'}
            </button>
            <button
              type="button"
              className="cc-activity-toggle"
              onClick={() => setShowRaw((current) => !current)}
              aria-expanded={showRaw}
            >
              {showRaw ? 'Hide Raw' : 'Raw'}
            </button>
          </div>
        </div>

        <div className="cc-activity-summary-strip" aria-label="Terminal activity summary">
          {groups.map((group) => (
            <span key={group.id} className="cc-activity-chip">
              <span className="cc-activity-chip-name">{group.label}</span>
              <span className="cc-activity-count">{group.items.length}</span>
            </span>
          ))}
        </div>

        {expanded && (
          <div className="cc-activity-groups" aria-label="Grouped terminal activity">
            {groups.map((group) => {
              const groupExpanded = expandedGroups.has(group.id);
              const visibleItems = groupExpanded ? group.items : group.items.slice(0, 3);
              const hiddenCount = Math.max(group.items.length - visibleItems.length, 0);

              return (
                <section key={group.id} className="cc-activity-group">
                  <button
                    type="button"
                    className="cc-activity-group-header"
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={groupExpanded}
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
                      {groupExpanded ? 'Show less' : `${hiddenCount} more`}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {showRaw && (
          <pre className="cc-activity-raw" aria-label="Raw terminal transcript" tabIndex={0} data-conversation-scroll-region>
            {String(content || '')}
          </pre>
        )}
      </div>
    </div>
  );
}

function MessageActions({ item }) {
  const copyText = typeof item.content === 'string' ? item.content : item.copyText;
  const actions = Array.isArray(item.actions) ? item.actions : [];
  if (!copyText && !actions.length) return null;
  return <div className="cc-message-actions">
    {copyText && <CopyButton text={copyText} label="Copy message" />}
    {actions.map(action => <button key={action.label} type="button" className="cc-message-action" onClick={action.onClick}>{action.label}</button>)}
  </div>;
}

export default memo(function ToolCallBlock({ item, onFileClick, workspacePath, onProjectFileClick }) {
  // Default to collapsed for tool blocks
  const [expanded, setExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const detailsId = useId();

  // T3-style chrome: no visible speaker labels (kept for screen readers), actions beneath on hover.
  if (item.type === 'user') {
    return (
      <div className="cc-message cc-user cc-transcript-message">
        <span className="cc-message-author cc-sr-only">You</span>
        <div className="cc-user-bubble">
          <div className="cc-user-content">{item.content}</div>
        </div>
        <MessageActions item={item} />
      </div>
    );
  }

  if (item.type === 'assistant') {
    return (
      <div className="cc-message cc-assistant cc-transcript-message">
        <div className="cc-assistant-bubble">
          <span className="cc-message-author cc-sr-only">{item.roleLabel || 'Assistant'}</span>
          <div className="cc-assistant-content">
            <MarkdownContent content={item.content} workspacePath={workspacePath} onFileClick={onProjectFileClick} />
          </div>
        </div>
        <MessageActions item={item} />
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
      <div className={`cc-message cc-system ${item.isError ? 'error' : ''}`} role={item.isError ? 'alert' : 'status'}>
        {item.content}
      </div>
    );
  }

  // Tool use block - compact collapsed style
  if (item.type === 'tool_use') {
    const tool = item.tool?.toLowerCase() || 'default';
    const displayInfo = getToolDisplayInfo(item);

    const hasResult = !!item.result;
    const isError = item.result?.isError;
    const output = item.result?.toolResult || '';
    const isRunning = !hasResult;
    const sessionTodos = tool === 'todo_list' && !isError && hasResult ? sessionTodoResult(output) : null;
    const delegationResults = tool === 'delegate_tasks' && !isError && hasResult ? parallelDelegationResults(output) : null;
    const backgroundStart = tool === 'delegate_task_background' && !isError && hasResult ? backgroundDelegationStart(output) : null;

    // Generate summary for the header
    const summary = backgroundStart ? 'Delivery details' : sessionTodos ? `${sessionTodos.length} ${sessionTodos.length === 1 ? 'task' : 'tasks'}` : hasResult && !output ? (isError ? 'Error' : 'No output') : generateToolSummary(item.tool, item.toolInput, output, isError);

    // Edit tool with diff
    const isEditTool = tool === 'edit' || tool === 'replace_text';
    const hasDiffData = isEditTool && typeof displayInfo.oldString === 'string' && typeof displayInfo.newString === 'string';

    // Output handling for expanded view
    const outputLines = output ? output.replace(/\n+$/, '').split('\n') : [];
    const maxInitialLines = 12;
    const hasMoreOutput = outputLines.length > maxInitialLines;
    const displayLines = showFullOutput ? outputLines : outputLines.slice(0, maxInitialLines);
    const state = isRunning ? 'running' : isError ? 'failed' : 'completed';
    const OutputContainer = sessionTodos || delegationResults || backgroundStart ? 'details' : 'div';

    return (
      <div className={`cc-message cc-tool-compact ${isError ? 'error' : ''}`}>
        <button type="button"
          className={`cc-tool-header ${expanded ? 'expanded' : ''}`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          title={displayInfo.input || undefined}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="cc-tool-expand" aria-hidden="true">›</span>
          <span className="cc-tool-name">{displayInfo.title}</span>
          {displayInfo.detail && <span className="cc-tool-path">{displayInfo.detail}</span>}
          <span className={`cc-tool-state is-${state}`}>{isRunning ? 'Running' : isError ? 'Failed' : backgroundStart ? 'Started' : tool === 'delegate_task_background' ? 'Response received' : 'Completed'}</span>
          <span className="cc-tool-summary">{summary}</span>
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className="cc-tool-body" id={detailsId}>
            {displayInfo.browserTool && <div className="cc-tool-section">
              <div className="cc-tool-section-label">Tool <code>{displayInfo.rawTool}</code></div>
              {displayInfo.server && <div className="cc-tool-section-label">Server <code>{displayInfo.server}</code></div>}
            </div>}
            {tool === 'todowrite' && <TodoWidget todos={displayInfo.todos} />}
            {sessionTodos && <SessionTodoWidget todos={sessionTodos} />}
            {delegationResults && <section className="cc-tool-section" aria-label="Investigation results">
              {delegationResults.map((result, index) => <div key={index}>
                <div className="cc-tool-section-label">Task {index + 1} · {result.status === 'completed' ? 'Completed' : 'Failed'}{result.truncated ? ' · Truncated' : ''}</div>
                <div className="cc-tool-output" tabIndex={0} data-conversation-scroll-region>{result.status === 'completed' ? result.result : result.error}</div>
              </div>)}
            </section>}
            {backgroundStart && <section className="cc-tool-section">
              <p>{backgroundStart.delivery}</p>
              <p>Find retained results in Project tools → Tasks &amp; schedules.</p>
            </section>}
            {displayInfo.input && (
              <section className="cc-tool-section">
                <div className="cc-tool-section-label">
                  {displayInfo.inputLabel || 'Input'}
                  {displayInfo.cwd && <span className="cc-tool-section-meta" title={displayInfo.cwd}>in {displayInfo.cwd}</span>}
                  <CopyButton text={displayInfo.input} label="Copy input" />
                </div>
                <pre className="cc-tool-input" tabIndex={0} aria-label={displayInfo.inputLabel || 'Input'} data-conversation-scroll-region>{displayInfo.input}</pre>
              </section>
            )}
            {/* Diff view for Edit */}
            {hasDiffData && (
              <DiffView
                oldString={displayInfo.oldString}
                newString={displayInfo.newString}
                filePath={displayInfo.input}
              />
            )}

            {/* Output */}
            {hasResult && output && (!hasDiffData || isError) && (
              <OutputContainer className={sessionTodos || delegationResults || backgroundStart ? 'cc-todo-raw' : undefined}>
              {(sessionTodos || delegationResults || backgroundStart) && <summary>Raw result</summary>}
              <section className="cc-tool-section">
                <div className="cc-tool-section-label">
                  {isError ? 'Error output' : 'Output'}
                  <CopyButton text={output} label={isError ? 'Copy error output' : 'Copy output'} />
                </div>
                <div className="cc-tool-output" tabIndex={0} role="region" aria-label={isError ? 'Error output' : 'Output'} data-conversation-scroll-region>
                  {displayLines.map((line, idx) => (
                    <div key={idx} className="cc-output-line">
                      {onProjectFileClick && workspacePath ? parseProjectFileLinks(line, workspacePath, onProjectFileClick)
                        : onFileClick ? parseFileLinks(line, onFileClick) : line || ' '}
                    </div>
                  ))}
                </div>
                {hasMoreOutput && !showFullOutput && (
                  <button type="button" className="cc-show-more-btn" onClick={(e) => { e.stopPropagation(); setShowFullOutput(true); }}>
                    Show {outputLines.length - maxInitialLines} more lines
                  </button>
                )}
                {showFullOutput && hasMoreOutput && (
                  <button type="button" className="cc-show-more-btn" onClick={(e) => { e.stopPropagation(); setShowFullOutput(false); }}>
                    Show less
                  </button>
                )}
              </section>
              </OutputContainer>
            )}

            {hasResult && !output && !isError && !hasDiffData && (
              <div className="cc-tool-empty-output">No output</div>
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
