import { useState } from 'react';

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function ActionIcon({ type }) {
  switch (type) {
    case 'goto':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 16 16 12 12 8"></polyline>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
      );
    case 'click':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 9h6v6h-6z"></path>
          <path d="M3 3l3 3"></path>
          <path d="M21 3l-3 3"></path>
        </svg>
      );
    case 'type':
    case 'fill':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <line x1="2" y1="12" x2="22" y2="12"></line>
        </svg>
      );
    case 'select':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      );
    case 'scroll':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
      );
    case 'hover':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path>
        </svg>
      );
    case 'wait':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      );
    case 'assertion':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      );
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
        </svg>
      );
  }
}

function ActionItem({ action, index, isPlaying }) {
  const [expanded, setExpanded] = useState(false);

  const getActionLabel = () => {
    switch (action.type) {
      case 'goto':
        return `Navigate to ${action.url}`;
      case 'click':
        return `Click ${action.selector}`;
      case 'type':
        return `Type "${action.text}" into ${action.selector}`;
      case 'fill':
        return `Fill ${action.selector} with "${action.value}"`;
      case 'select':
        return `Select "${action.value}" in ${action.selector}`;
      case 'scroll':
        return action.selector ? `Scroll in ${action.selector}` : 'Scroll page';
      case 'hover':
        return `Hover ${action.selector}`;
      case 'wait':
        if (action.waitType === 'selector') {
          return `Wait for ${action.selector}`;
        } else if (action.waitType === 'timeout') {
          return `Wait ${action.timeout}ms`;
        } else if (action.waitType === 'navigation') {
          return 'Wait for navigation';
        }
        return 'Wait';
      case 'assertion':
        return `Assert ${action.assertionType}: ${action.selector}`;
      default:
        return action.type;
    }
  };

  return (
    <div className={`action-item ${isPlaying ? 'playing' : ''} ${expanded ? 'expanded' : ''}`}>
      <div className="action-header" onClick={() => setExpanded(!expanded)}>
        <div className="action-icon">
          <ActionIcon type={action.type} />
        </div>
        <div className="action-info">
          <div className="action-label">{getActionLabel()}</div>
          <div className="action-meta">
            <span className="action-index">#{index + 1}</span>
            <span className="action-timestamp">{formatTimestamp(action.timestamp)}</span>
          </div>
        </div>
        <div className="action-expand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}></polyline>
          </svg>
        </div>
      </div>

      {expanded && (
        <div className="action-details">
          <table>
            <tbody>
              <tr>
                <td className="detail-key">Type</td>
                <td className="detail-value">{action.type}</td>
              </tr>
              {action.selector && (
                <tr>
                  <td className="detail-key">Selector</td>
                  <td className="detail-value"><code>{action.selector}</code></td>
                </tr>
              )}
              {action.url && (
                <tr>
                  <td className="detail-key">URL</td>
                  <td className="detail-value"><code>{action.url}</code></td>
                </tr>
              )}
              {action.text !== undefined && (
                <tr>
                  <td className="detail-key">Text</td>
                  <td className="detail-value"><code>{action.text}</code></td>
                </tr>
              )}
              {action.value !== undefined && (
                <tr>
                  <td className="detail-key">Value</td>
                  <td className="detail-value"><code>{JSON.stringify(action.value)}</code></td>
                </tr>
              )}
              {action.timeout && (
                <tr>
                  <td className="detail-key">Timeout</td>
                  <td className="detail-value">{action.timeout}ms</td>
                </tr>
              )}
              {action.assertionType && (
                <tr>
                  <td className="detail-key">Assertion</td>
                  <td className="detail-value">{action.assertionType}</td>
                </tr>
              )}
              {action.expected !== undefined && (
                <tr>
                  <td className="detail-key">Expected</td>
                  <td className="detail-value"><code>{JSON.stringify(action.expected)}</code></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <style jsx>{`
        .action-item {
          background: var(--bg-secondary, #252525);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 6px;
          margin-bottom: 8px;
          transition: all 0.2s;
        }

        .action-item:hover {
          border-color: #3b82f6;
        }

        .action-item.playing {
          background: rgba(59, 130, 246, 0.1);
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }

        .action-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          cursor: pointer;
        }

        .action-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          background: var(--bg-primary, #1e1e1e);
          color: #3b82f6;
          flex-shrink: 0;
        }

        .action-info {
          flex: 1;
          min-width: 0;
        }

        .action-label {
          font-size: 14px;
          color: var(--text-primary, #d4d4d4);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin-bottom: 4px;
        }

        .action-meta {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 11px;
          color: var(--text-tertiary, #666);
        }

        .action-index {
          padding: 2px 6px;
          background: var(--bg-primary, #1e1e1e);
          border-radius: 3px;
        }

        .action-expand {
          display: flex;
          align-items: center;
          color: var(--text-secondary, #999);
          flex-shrink: 0;
        }

        .action-details {
          padding: 12px;
          border-top: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-primary, #1e1e1e);
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        tr:not(:last-child) {
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        td {
          padding: 8px 0;
          font-size: 13px;
        }

        .detail-key {
          width: 120px;
          color: var(--text-secondary, #999);
          font-weight: 600;
          vertical-align: top;
        }

        .detail-value {
          color: var(--text-primary, #d4d4d4);
        }

        .detail-value code {
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          background: var(--bg-secondary, #252525);
          padding: 2px 6px;
          border-radius: 3px;
          color: #3b82f6;
        }
      `}</style>
    </div>
  );
}

export function ActionList({ actions, currentActionIndex = -1 }) {
  if (actions.length === 0) {
    return (
      <div className="action-list-empty">
        <p>No actions recorded yet</p>
      </div>
    );
  }

  return (
    <div className="action-list">
      {actions.map((action, index) => (
        <ActionItem
          key={index}
          action={action}
          index={index}
          isPlaying={index === currentActionIndex}
        />
      ))}

      <style jsx>{`
        .action-list {
          flex: 1;
          overflow-y: auto;
          padding: 16px 20px;
        }

        .action-list-empty {
          padding: 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }
      `}</style>
    </div>
  );
}
