import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../utils/api';
import { useMobileDetect } from '../hooks/useMobileDetect';

const HISTORY_CHARS_DESKTOP = 5_000_000;
const HISTORY_CHARS_MOBILE = 300_000;

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function normalizeHistory(text) {
  return stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function TerminalHistoryModal({ isOpen, sessionId, onClose }) {
  const isMobile = useMobileDetect();
  const historyChars = isMobile ? HISTORY_CHARS_MOBILE : HISTORY_CHARS_DESKTOP;
  const [historyText, setHistoryText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const textAreaRef = useRef(null);

  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let isCurrent = true;
    setIsLoading(true);
    setError('');
    apiGet(`/api/terminal/${sessionId}/history?historyChars=${historyChars}`)
      .then((data) => {
        if (!isCurrent) return;
        const joined = Array.isArray(data.history)
          ? data.history.map((entry) => entry.text || '').join('')
          : '';
        setHistoryText(normalizeHistory(joined));
      })
      .catch((err) => {
        if (!isCurrent) return;
        setError(err?.message || 'Failed to load history');
        setHistoryText('');
      })
      .finally(() => {
        if (!isCurrent) return;
        setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [historyChars, isOpen, sessionId]);

  useEffect(() => {
    if (!isOpen || !textAreaRef.current) return;
    textAreaRef.current.scrollTop = 0;
  }, [isOpen, historyText]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content terminal-history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Terminal History</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body terminal-history-body">
          {isLoading && <div className="terminal-history-loading">Loading history...</div>}
          {error && <div className="terminal-history-error">{error}</div>}
          {!isLoading && !error && (
            <textarea
              ref={textAreaRef}
              className="terminal-history-textarea"
              value={historyText}
              readOnly
              spellCheck={false}
              aria-label="Terminal history"
            />
          )}
        </div>
      </div>
    </div>
  );
}
