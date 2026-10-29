import { useLayoutEffect, useRef, useState } from 'react';
import './LogViewer.css';

/**
 * LogViewer - Simple log viewer for handling large log lists
 */
export function LogViewer({ logs, height = 400, itemHeight = 24, renderLog }) {
  const listRef = useRef(null);
  const previousLogsRef = useRef(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const viewer = listRef.current;
    const previous = previousLogsRef.current;
    previousLogsRef.current = logs;
    if (!viewer) return;

    const retainedStart = previous?.findIndex(log =>
      log === logs[0] || (log.id != null && log.id === logs[0]?.id)
    ) ?? -1;
    const retainedCount = previous ? previous.length - retainedStart : 0;
    const continues = retainedStart >= 0 && logs.length >= retainedCount && previous.slice(retainedStart).every((log, index) =>
      log === logs[index] || (log.id != null && log.id === logs[index]?.id)
    );
    const appended = continues && logs.length > retainedCount;
    const unchanged = continues && retainedStart === 0 && logs.length === previous.length;
    if (!previous || (appended && followingRef.current)) {
      viewer.scrollTop = viewer.scrollHeight;
    } else if (!appended && !unchanged) {
      viewer.scrollTop = 0;
    }
    followingRef.current = viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop <= 32;
    setFollowing(followingRef.current);
  }, [logs]);

  const handleScroll = () => {
    const viewer = listRef.current;
    followingRef.current = viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop <= 32;
    setFollowing(followingRef.current);
  };

  const jumpToLatest = () => {
    listRef.current.scrollTop = listRef.current.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  };

  if (logs.length === 0) {
    return (
      <div className="devtools-empty-state" style={{ height }}>
        <p>No logs to display</p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={listRef}
        className="log-viewer"
        role="region"
        aria-label="Console logs"
        tabIndex={0}
        onScroll={handleScroll}
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
      <div className="log-viewer-actions">
        {!following && (
          <button type="button" className="log-viewer-latest" onClick={jumpToLatest}>
            Jump to latest
          </button>
        )}
      </div>
    </>
  );
}
