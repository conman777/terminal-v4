import { useRef, useEffect } from 'react';
import { FixedSizeList } from 'react-window';

/**
 * LogViewer - Virtualized log viewer for handling large log lists
 * Uses react-window for efficient rendering of 10K+ logs
 */
export function LogViewer({ logs, height = 400, itemHeight = 24, renderLog }) {
  const listRef = useRef(null);
  const prevLogsLengthRef = useRef(logs.length);

  // Auto-scroll to bottom when new logs are added
  useEffect(() => {
    if (logs.length > prevLogsLengthRef.current && listRef.current) {
      listRef.current.scrollToItem(logs.length - 1, 'end');
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

  const Row = ({ index, style }) => {
    const log = logs[index];
    return (
      <div style={style} className="log-viewer-row">
        {renderLog(log, index)}
      </div>
    );
  };

  return (
    <FixedSizeList
      ref={listRef}
      height={height}
      itemCount={logs.length}
      itemSize={itemHeight}
      width="100%"
      className="log-viewer"
    >
      {Row}
    </FixedSizeList>
  );
}
