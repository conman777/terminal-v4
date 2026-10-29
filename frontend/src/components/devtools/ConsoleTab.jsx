import { useEffect, useRef, useState, useMemo } from 'react';
import { FilterBar } from './shared/FilterBar';
import { LogViewer } from './shared/LogViewer';
import { JsonTreeView } from './shared/JsonTreeView';
import './ConsoleTab.css';

/**
 * ConsoleTab - Console logging with virtualization for 10K+ logs
 * Features:
 * - Log levels with icons (log, warn, error, info, debug)
 * - Expandable objects with JSON tree view
 * - Stack traces for errors
 * - Virtual scrolling for performance
 * - REPL evaluation (evaluate JavaScript in preview context)
 */
export function ConsoleTab({ logs = [], onClear, onEvaluate, previewPort }) {
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [replInput, setReplInput] = useState('');
  const [replHistory, setReplHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyDraft = useRef('');
  const currentInput = useRef('');
  const evaluation = useRef(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState('');

  useEffect(() => {
    evaluation.current = null;
    currentInput.current = '';
    historyDraft.current = '';
    setReplInput('');
    setReplHistory([]);
    setHistoryIndex(-1);
    setIsEvaluating(false);
    setEvaluationError('');
    return () => { evaluation.current = null; };
  }, [previewPort]);

  // Filter logs by level
  const filteredLogs = useMemo(() => {
    let filtered = logs;

    // Apply level filter
    if (filter !== 'all') {
      filtered = filtered.filter(log => (log.level || 'log') === filter);
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(log => {
        const message = (log.message || '').toLowerCase();
        const level = (log.level || '').toLowerCase();
        return message.includes(query) || level.includes(query);
      });
    }

    return filtered;
  }, [logs, filter, searchQuery]);

  // Count logs by level
  const counts = useMemo(() => {
    const result = { all: logs.length, log: 0, warn: 0, error: 0, info: 0, debug: 0 };
    logs.forEach(log => {
      const level = log.level || 'log';
      if (result[level] !== undefined) {
        result[level]++;
      }
    });
    return result;
  }, [logs]);

  const filters = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'log', label: 'Logs', icon: '💬', count: counts.log },
    { value: 'warn', label: 'Warnings', icon: '⚠️', count: counts.warn },
    { value: 'error', label: 'Errors', icon: '❌', count: counts.error },
    { value: 'info', label: 'Info', icon: 'ℹ️', count: counts.info },
    { value: 'debug', label: 'Debug', icon: '🔍', count: counts.debug }
  ];

  const getLevelIcon = (level) => {
    switch (level) {
      case 'warn': return '⚠️';
      case 'error': return '❌';
      case 'info': return 'ℹ️';
      case 'debug': return '🔍';
      default: return '💬';
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  };

  const handleEvaluateRepl = async () => {
    if (!replInput.trim() || !onEvaluate || evaluation.current) return;

    const expression = replInput.trim();
    const owner = {};
    evaluation.current = owner;
    setIsEvaluating(true);
    setEvaluationError('');
    setReplHistory(prev => [...prev, expression]);
    setHistoryIndex(-1);
    setReplInput('');
    currentInput.current = '';
    historyDraft.current = '';

    try {
      await onEvaluate(expression);
    } catch (error) {
      if (evaluation.current === owner) {
        setEvaluationError(`Evaluation failed. ${error?.message || 'Try again.'}`);
        if (!currentInput.current) {
          setReplInput(expression);
          currentInput.current = expression;
        }
      }
    } finally {
      if (evaluation.current === owner) {
        evaluation.current = null;
        setIsEvaluating(false);
      }
    }
  };

  const handleReplKeyDown = (e) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEvaluateRepl();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (replHistory.length > 0) {
        if (historyIndex === -1) historyDraft.current = replInput;
        const newIndex = historyIndex === -1 ? replHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setReplInput(replHistory[newIndex]);
        currentInput.current = replHistory[newIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= replHistory.length) {
          setHistoryIndex(-1);
          setReplInput(historyDraft.current);
          currentInput.current = historyDraft.current;
        } else {
          setHistoryIndex(newIndex);
          setReplInput(replHistory[newIndex]);
          currentInput.current = replHistory[newIndex];
        }
      }
    }
  };

  const parseMessage = (message) => {
    // Try to parse as JSON for object logging
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed === 'object' && parsed !== null) {
        return { type: 'object', value: parsed };
      }
    } catch {
      // Not JSON, return as string
    }
    return { type: 'string', value: message };
  };

  const renderLog = (log, index) => {
    const parsed = parseMessage(log.message);

    return (
      <div className={`console-log console-${log.level}`}>
        <span className="console-icon">{getLevelIcon(log.level)}</span>
        <span className="console-timestamp">{formatTimestamp(log.timestamp)}</span>
        <div className="console-message">
          {parsed.type === 'object' ? (
            <JsonTreeView data={parsed.value} initialExpanded={false} />
          ) : (
            <span className="console-text">{parsed.value}</span>
          )}
          {log.stack && (
            <details className="console-stack">
              <summary>Stack trace</summary>
              <pre className="stack-trace">{log.stack}</pre>
            </details>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="console-tab">
      <div className="console-toolbar">
        <FilterBar
          filters={filters}
          activeFilter={filter}
          onFilterChange={setFilter}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          placeholder="Filter console..."
        />
        <div className="console-actions">
          <button type="button" onClick={onClear} className="btn-icon" title="Clear console">
            🗑️
          </button>
        </div>
      </div>

      <div className="console-content">
        {filteredLogs.length === 0 ? (
          <div className="console-empty">
            <p>{logs.length === 0 ? 'No console logs' : 'No logs match filters'}</p>
          </div>
        ) : (
          <LogViewer
            logs={filteredLogs}
            height={onEvaluate ? 350 : 450}
            itemHeight={32}
            renderLog={renderLog}
          />
        )}
      </div>

      {onEvaluate && previewPort && (
        <div className="console-repl">
          <div className="repl-prompt">
            <span className="repl-chevron">&gt;</span>
            <input
              type="text"
              value={replInput}
              onChange={(e) => {
                setReplInput(e.target.value);
                currentInput.current = e.target.value;
                setHistoryIndex(-1);
              }}
              onKeyDown={handleReplKeyDown}
              placeholder="Evaluate JavaScript in preview context..."
              className="repl-input"
              aria-label="JavaScript expression"
            />
            <button
              onClick={handleEvaluateRepl}
              type="button"
              disabled={!replInput.trim() || isEvaluating}
              className="repl-button"
            >
              Run
            </button>
          </div>
          {evaluationError && <p role="alert">{evaluationError}</p>}
          <div className="repl-hint">
            Press Enter to evaluate, ↑/↓ for history
          </div>
        </div>
      )}
    </div>
  );
}
