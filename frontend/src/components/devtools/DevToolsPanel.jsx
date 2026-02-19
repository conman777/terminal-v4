import { useEffect, useState } from 'react';
import { NetworkTab } from './NetworkTab';
import { ConsoleTab } from './ConsoleTab';
import { StorageTab } from './StorageTab';
import { PerformanceTab } from './PerformanceTab';
import { WebSocketTab } from './WebSocketTab';
import '../../devtools.css';

const PERFORMANCE_TAB_ENABLED = import.meta.env.VITE_ENABLE_PERFORMANCE_TAB === 'true';

/**
 * DevToolsPanel - Main container for DevTools tabs
 * Provides browser-like developer tools for preview panel
 */
export function DevToolsPanel({
  networkRequests = [],
  consoleLogs = [],
  storage = {},
  previewPort,
  onClearNetwork,
  onClearConsole,
  onUpdateStorage,
  onEvaluate
}) {
  const [activeTab, setActiveTab] = useState('network');

  useEffect(() => {
    if (!PERFORMANCE_TAB_ENABLED && activeTab === 'performance') {
      setActiveTab('network');
    }
  }, [activeTab]);

  const tabs = [
    { id: 'network', label: 'Network', count: networkRequests.length },
    { id: 'console', label: 'Console', count: consoleLogs.length },
    { id: 'storage', label: 'Storage', count: Object.keys(storage.localStorage || {}).length },
    ...(PERFORMANCE_TAB_ENABLED ? [{ id: 'performance', label: 'Performance', count: null }] : []),
    { id: 'websocket', label: 'WebSocket', count: null }
  ];

  return (
    <div className="devtools-panel">
      <div className="devtools-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`devtools-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-label">{tab.label}</span>
            {tab.count > 0 && (
              <span className="tab-badge">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="devtools-content">
        {activeTab === 'network' && (
          <NetworkTab
            requests={networkRequests}
            onClear={onClearNetwork}
          />
        )}
        {activeTab === 'console' && (
          <ConsoleTab
            logs={consoleLogs}
            onClear={onClearConsole}
            onEvaluate={onEvaluate}
            previewPort={previewPort}
          />
        )}
        {activeTab === 'storage' && (
          <StorageTab
            storage={storage}
            onUpdateStorage={onUpdateStorage}
            previewPort={previewPort}
          />
        )}
        {PERFORMANCE_TAB_ENABLED && activeTab === 'performance' && (
          <PerformanceTab
            port={previewPort}
          />
        )}
        {activeTab === 'websocket' && (
          <WebSocketTab
            port={previewPort}
          />
        )}
      </div>
    </div>
  );
}
