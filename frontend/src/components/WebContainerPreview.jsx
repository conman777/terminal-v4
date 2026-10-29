import { isTrustedWebContainerUrl } from '../utils/webcontainerWindow';
import { apiFetch } from '../utils/api';
import './preview/PreviewPanel.css';
/**
 * WebContainerPreview Component
 *
 * Renders a preview panel that runs Node.js dev servers in the browser
 * using WebContainers (WebAssembly-based Node.js runtime).
 *
 * States: CHECKING → BOOTING → MOUNTING → INSTALLING → STARTING → READY
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  isWebContainerSupported,
  getWebContainer,
  mountFiles,
  installDependencies,
  startDevServer,
  createPreviewSession
} from '../utils/webcontainer';

// Status phases
const STATUS = {
  CHECKING: 'checking',
  UNSUPPORTED: 'unsupported',
  BOOTING: 'booting',
  MOUNTING: 'mounting',
  INSTALLING: 'installing',
  STARTING: 'starting',
  READY: 'ready',
  ERROR: 'error'
};

// Status messages for display
const STATUS_MESSAGES = {
  [STATUS.CHECKING]: 'Checking WebContainer support...',
  [STATUS.UNSUPPORTED]: 'WebContainers not supported',
  [STATUS.BOOTING]: 'Booting WebContainer...',
  [STATUS.MOUNTING]: 'Mounting project files...',
  [STATUS.INSTALLING]: 'Installing dependencies...',
  [STATUS.STARTING]: 'Starting dev server...',
  [STATUS.READY]: 'Ready',
  [STATUS.ERROR]: 'Error'
};

export function WebContainerPreview({
  projectFiles,
  projectPath,
  startCommand = 'npm run dev',
  onStatusChange,
  onServerReady,
  onError,
  onConsoleLog,
  onFallbackToProxy,
  isScopeCurrent
}) {
  const [status, setStatus] = useState(STATUS.CHECKING);
  const [statusMessage, setStatusMessage] = useState(STATUS_MESSAGES[STATUS.CHECKING]);
  const [serverUrl, setServerUrl] = useState(null);
  const [serverPort, setServerPort] = useState(null);
  const [logs, setLogs] = useState([]);
  const [errorDetails, setErrorDetails] = useState(null);
  const [installProgress, setInstallProgress] = useState('');

  const iframeRef = useRef(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const callbacksRef = useRef({});
  callbacksRef.current = { onStatusChange, onConsoleLog, onError, onServerReady };

  // Update status with callback
  const updateStatus = useCallback((newStatus, message) => {
    setStatus(newStatus);
    setStatusMessage(message || STATUS_MESSAGES[newStatus]);
    callbacksRef.current.onStatusChange?.(newStatus, message || STATUS_MESSAGES[newStatus]);
  }, []);

  // Add log entry
  const addLog = useCallback((text, type = 'info') => {
    const entry = {
      id: Date.now() + Math.random(),
      timestamp: Date.now(),
      text,
      type
    };
    setLogs(prev => [...prev.slice(-200), entry]);
    callbacksRef.current.onConsoleLog?.(entry);
  }, []);

  // Handle errors
  const handleError = useCallback((error, phase) => {
    console.error(`[WebContainer] Error during ${phase}:`, error);
    const errorMsg = error.message || String(error);
    setErrorDetails({ phase, message: errorMsg });
    updateStatus(STATUS.ERROR, `Error during ${phase}: ${errorMsg}`);
    addLog(`Error: ${errorMsg}`, 'error');
    callbacksRef.current.onError?.(error, phase);
  }, [updateStatus, addLog]);

  useEffect(() => {
    const session = createPreviewSession();
    updateStatus(STATUS.CHECKING);
    setServerUrl(null);
    setServerPort(null);
    setLogs([]);
    setErrorDetails(null);
    setInstallProgress('');

    session.run(async signal => {
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (isScopeCurrent && !isScopeCurrent()) {
          session.dispose();
          throw new DOMException('The project account or environment changed', 'AbortError');
        }
      };
      assertCurrent();
      updateStatus(STATUS.CHECKING);
      const support = isWebContainerSupported();
      if (!support.supported) {
        updateStatus(STATUS.UNSUPPORTED, support.reason);
        setErrorDetails({ phase: 'support', message: support.reason });
        return;
      }

      updateStatus(STATUS.BOOTING);
      addLog('Booting WebContainer...');
      assertCurrent();
      await getWebContainer();
      assertCurrent();
      addLog('WebContainer booted successfully');

      let files = projectFiles;
      if (!files || Object.keys(files).length === 0) {
        if (!projectPath) {
          updateStatus(STATUS.READY);
          return;
        }
        updateStatus(STATUS.MOUNTING, 'Fetching project files...');
        assertCurrent();
        const response = await apiFetch(`/api/webcontainer/files?path=${encodeURIComponent(projectPath)}`, { signal });
        assertCurrent();
        if (!response.ok) throw new Error(`Failed to fetch files: ${response.statusText}`);
        assertCurrent();
        const data = await response.json();
        assertCurrent();
        files = data.files;
        if (!files || Object.keys(files).length === 0) throw new Error('No files found in project');
      }

      updateStatus(STATUS.MOUNTING);
      assertCurrent();
      await mountFiles(files, { signal, replace: true, assertCurrent });
      assertCurrent();
      updateStatus(STATUS.INSTALLING);
      addLog('Running npm install...');
      const installExitCode = await installDependencies(output => {
        if (signal.aborted || isScopeCurrent && !isScopeCurrent()) return;
        const text = output.trim();
        if (text) {
          if (text.includes('added') || text.includes('packages')) setInstallProgress(text);
          addLog(text);
        }
      }, { signal, assertCurrent });
      assertCurrent();
      if (installExitCode !== 0) throw new Error(`npm install failed with exit code ${installExitCode}`);

      updateStatus(STATUS.STARTING);
      const [cmd, ...args] = startCommand.trim().split(/\s+/);
      addLog(`Starting: ${startCommand}`);
      const { url, port } = await startDevServer(cmd, args, output => {
        if (!signal.aborted && (!isScopeCurrent || isScopeCurrent()) && output.trim()) addLog(output.trim());
      }, { signal, assertCurrent, onExit: error => {
        if (signal.aborted || isScopeCurrent && !isScopeCurrent()) return;
        session.dispose();
        setServerUrl(null);
        setServerPort(null);
        handleError(error, 'dev server');
      } });
      assertCurrent();
      if (!isTrustedWebContainerUrl(url)) throw new Error('The runtime returned an untrusted preview origin.');
      setServerUrl(url);
      setServerPort(port);
      updateStatus(STATUS.READY);
      addLog(`Dev server ready at ${url}`);
      callbacksRef.current.onServerReady?.(url, port);
    }).catch(error => {
      if (session.signal.aborted) return;
      session.dispose();
      handleError(error, 'initialization');
    });

    return () => session.dispose();
  }, [projectFiles, projectPath, startCommand, retryGeneration, updateStatus, addLog, handleError, isScopeCurrent]);

  // Handle fallback button click
  const handleFallback = useCallback(() => {
    if (onFallbackToProxy) {
      onFallbackToProxy();
    }
  }, [onFallbackToProxy]);

  const handleRetry = useCallback(() => {
    setRetryGeneration(generation => generation + 1);
  }, []);

  // Render based on status
  if (status === STATUS.UNSUPPORTED) {
    return (
      <div className="webcontainer-preview webcontainer-unsupported">
        <div className="webcontainer-status">
          <div className="webcontainer-status-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h3>WebContainers Not Available</h3>
          <p>{errorDetails?.message || 'Your browser does not support WebContainers.'}</p>
          <p className="webcontainer-hint">
            WebContainers run Node.js in your browser and require Chrome or Edge.
            Use the standard proxy preview instead for Firefox and Safari.
          </p>
          {onFallbackToProxy && (
            <button type="button" className="btn-primary" onClick={handleFallback}>
              Use Proxy Mode Instead
            </button>
          )}
        </div>
      </div>
    );
  }

  if (status === STATUS.ERROR) {
    return (
      <div className="webcontainer-preview webcontainer-error" role="alert">
        <div className="webcontainer-status">
          <div className="webcontainer-status-icon error">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h3>WebContainer Error</h3>
          <p>{errorDetails?.message}</p>
          {errorDetails?.phase && (
            <p className="webcontainer-error-phase">Failed during: {errorDetails.phase}</p>
          )}
          <div className="webcontainer-error-actions">
            <button type="button" className="btn-secondary" onClick={handleRetry}>
              Retry
            </button>
            {onFallbackToProxy && (
              <button type="button" className="btn-primary" onClick={handleFallback}>
                Use Proxy Mode
              </button>
            )}
          </div>
        </div>
        {logs.length > 0 && (
          <div className="webcontainer-logs">
            <div className="webcontainer-logs-header">Logs</div>
            <div className="webcontainer-logs-content">
              {logs.slice(-20).map(log => (
                <div key={log.id} className={`webcontainer-log webcontainer-log-${log.type}`}>
                  {log.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (status !== STATUS.READY) {
    return (
      <div className="webcontainer-preview webcontainer-loading" role="status">
        <div className="webcontainer-status">
          <div className="webcontainer-spinner" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
              </path>
            </svg>
          </div>
          <h3>{statusMessage}</h3>
          {status === STATUS.INSTALLING && installProgress && (
            <p className="webcontainer-progress">{installProgress}</p>
          )}
          {status === STATUS.BOOTING && (
            <p className="webcontainer-hint">This may take a moment on first load...</p>
          )}
        </div>
        {logs.length > 0 && (
          <div className="webcontainer-logs">
            <div className="webcontainer-logs-header">Console</div>
            <div className="webcontainer-logs-content">
              {logs.slice(-10).map(log => (
                <div key={log.id} className={`webcontainer-log webcontainer-log-${log.type}`}>
                  {log.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Ready state - show iframe
  return (
    <div className="webcontainer-preview webcontainer-ready">
      <iframe
        ref={iframeRef}
        src={serverUrl}
        className="webcontainer-iframe"
        title="WebContainer Preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

export default WebContainerPreview;
