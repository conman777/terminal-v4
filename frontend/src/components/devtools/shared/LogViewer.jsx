import { useRef, useEffect } from 'react';

/**
 * LogViewer - Simple log viewer for handling large log lists
 */
export function LogViewer({ logs, height = 400, itemHeight = 24, renderLog }) {
  const listRef = useRef(null);
  const prevLogsLengthRef = useRef(logs.length);

  // Auto-scroll to bottom when new logs are added
  useEffect(() => {
    if (logs.length > prevLogsLengthRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLogsLengthRef.current = logs.length;
  }, [logs.length]);

  if (logs.length === 0) {
    return (
      <div className="devtools-empty-state" style={{ height }}>
        <p>No logs to display</p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="log-viewer"
      style={{ height, overflowY: 'auto' }}
    >
      {logs.map((log, index) => (
        <div
          key={log.id ?? index}
          className="log-viewer-row"
          style={{ height: itemHeight }}
        >
          {renderLog(log, index)}
        </div>
      ))}
    </div>
  );
}
