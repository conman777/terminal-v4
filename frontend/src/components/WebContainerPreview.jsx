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
  writeFile,
  installDependencies,
  startDevServer,
  getStatus
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
  onFallbackToProxy
}) {
  const [status, setStatus] = useState(STATUS.CHECKING);
  const [statusMessage, setStatusMessage] = useState(STATUS_MESSAGES[STATUS.CHECKING]);
  const [serverUrl, setServerUrl] = useState(null);
  const [serverPort, setServerPort] = useState(null);
  const [logs, setLogs] = useState([]);
  const [errorDetails, setErrorDetails] = useState(null);
  const [installProgress, setInstallProgress] = useState('');

  const iframeRef = useRef(null);
  const serverProcessRef = useRef(null);
  const mountedRef = useRef(false);
  const initStartedRef = useRef(false);

  // Update status with callback
  const updateStatus = useCallback((newStatus, message) => {
    setStatus(newStatus);
    setStatusMessage(message || STATUS_MESSAGES[newStatus]);
    if (onStatusChange) {
      onStatusChange(newStatus, message || STATUS_MESSAGES[newStatus]);
    }
  }, [onStatusChange]);

  // Add log entry
  const addLog = useCallback((text, type = 'info') => {
    const entry = {
      id: Date.now() + Math.random(),
      timestamp: Date.now(),
      text,
      type
    };
    setLogs(prev => [...prev.slice(-200), entry]);
    if (onConsoleLog) {
      onConsoleLog(entry);
    }
  }, [onConsoleLog]);

  // Handle errors
  const handleError = useCallback((error, phase) => {
    console.error(`[WebContainer] Error during ${phase}:`, error);
    const errorMsg = error.message || String(error);
    setErrorDetails({ phase, message: errorMsg });
    updateStatus(STATUS.ERROR, `Error during ${phase}: ${errorMsg}`);
    addLog(`Error: ${errorMsg}`, 'error');
    if (onError) {
      onError(error, phase);
    }
  }, [updateStatus, addLog, onError]);

  // Initialize WebContainer
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    async function init() {
      try {
        // Step 1: Check support
        updateStatus(STATUS.CHECKING);
        const support = isWebContainerSupported();

        if (!support.supported) {
          updateStatus(STATUS.UNSUPPORTED, support.reason);
          setErrorDetails({ phase: 'support', message: support.reason });
          return;
        }

        // Step 2: Boot WebContainer
        updateStatus(STATUS.BOOTING);
        addLog('Booting WebContainer...');

        const wc = await getWebContainer();
        addLog('WebContainer booted successfully');

        // Step 3: Mount files if provided
        if (projectFiles && Object.keys(projectFiles).length > 0) {
          updateStatus(STATUS.MOUNTING);
          addLog(`Mounting ${Object.keys(projectFiles).length} files...`);

          await mountFiles(projectFiles);
          mountedRef.current = true;
          addLog('Files mounted successfully');
        } else if (projectPath) {
          // Fetch files from backend API
          updateStatus(STATUS.MOUNTING, 'Fetching project files...');
          addLog(`Fetching files from ${projectPath}...`);

          try {
            const response = await fetch(`/api/webcontainer/files?path=${encodeURIComponent(projectPath)}`);
            if (!response.ok) {
              throw new Error(`Failed to fetch files: ${response.statusText}`);
            }
            const data = await response.json();
            if (data.files && Object.keys(data.files).length > 0) {
              addLog(`Mounting ${Object.keys(data.files).length} files...`);
              await mountFiles(data.files);
              mountedRef.current = true;
              addLog('Files mounted successfully');
            } else {
              throw new Error('No files found in project');
            }
          } catch (err) {
            handleError(err, 'file fetch');
            return;
          }
        } else {
          // No files to mount - just boot
          addLog('No project files provided, WebContainer ready for use');
          updateStatus(STATUS.READY);
          return;
        }

        // Step 4: Install dependencies
        updateStatus(STATUS.INSTALLING);
        addLog('Running npm install...');

        const installExitCode = await installDependencies((output) => {
          const text = output.trim();
          if (text) {
            // Parse npm progress if possible
            if (text.includes('added') || text.includes('packages')) {
              setInstallProgress(text);
            }
            addLog(text);
          }
        });

        if (installExitCode !== 0) {
          handleError(new Error(`npm install failed with exit code ${installExitCode}`), 'install');
          return;
        }
        addLog('Dependencies installed successfully');

        // Step 5: Start dev server
        updateStatus(STATUS.STARTING);

        // Parse start command
        const [cmd, ...args] = startCommand.split(' ');
        addLog(`Starting: ${startCommand}`);

        const { url, port, process } = await startDevServer(cmd, args, (output) => {
          const text = output.trim();
          if (text) {
            addLog(text);
          }
        });

        serverProcessRef.current = process;
        setServerUrl(url);
        setServerPort(port);
        updateStatus(STATUS.READY);
        addLog(`Dev server ready at ${url}`);

        if (onServerReady) {
          onServerReady(url, port);
        }

      } catch (error) {
        handleError(error, 'initialization');
      }
    }

    init();
  }, [projectFiles, projectPath, startCommand, updateStatus, addLog, handleError, onServerReady]);

  // Handle file updates (for HMR)
  useEffect(() => {
    if (!mountedRef.current || !projectFiles) return;

    // This effect can be used to sync file changes
    // For now, we'll rely on the initial mount
  }, [projectFiles]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (serverProcessRef.current) {
        serverProcessRef.current.kill();
        serverProcessRef.current = null;
      }
    };
  }, []);

  // Handle fallback button click
  const handleFallback = useCallback(() => {
    if (onFallbackToProxy) {
      onFallbackToProxy();
    }
  }, [onFallbackToProxy]);

  // Retry initialization
  const handleRetry = useCallback(() => {
    initStartedRef.current = false;
    setStatus(STATUS.CHECKING);
    setErrorDetails(null);
    setLogs([]);
    setServerUrl(null);
    setServerPort(null);
    // Trigger re-init by updating a ref and forcing re-render
    window.location.reload();
  }, []);

  // Render based on status
  if (status === STATUS.UNSUPPORTED) {
    return (
      <div className="webcontainer-preview webcontainer-unsupported">
        <div className="webcontainer-status">
          <div className="webcontainer-status-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
      <div className="webcontainer-preview webcontainer-error">
        <div className="webcontainer-status">
          <div className="webcontainer-status-icon error">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
      <div className="webcontainer-preview webcontainer-loading">
        <div className="webcontainer-status">
          <div className="webcontainer-spinner">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0 12 12"
                  to="360 12 12"
                  dur="1s"
                  repeatCount="indefinite"
                />
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
        allow="camera; microphone"
      />
    </div>
  );
}

export default WebContainerPreview;
