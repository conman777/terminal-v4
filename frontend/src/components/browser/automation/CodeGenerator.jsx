import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../../../utils/api';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';

export function CodeGenerator({ recordingId, actions, onClose }) {
  const [framework, setFramework] = useState('playwright');
  const [language, setLanguage] = useState('javascript');
  const [testFramework, setTestFramework] = useState('none');
  const [generatedCode, setGeneratedCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    generateCode();
  }, [framework, language, testFramework]);

  useEffect(() => {
    if (codeRef.current && generatedCode) {
      Prism.highlightElement(codeRef.current);
    }
  }, [generatedCode]);

  const generateCode = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch('/api/browser/recorder/generate', {
        method: 'POST',
        body: JSON.stringify({
          recordingId,
          framework,
          language,
          testFramework: testFramework === 'none' ? undefined : testFramework
        })
      });

      setGeneratedCode(response.code);
    } catch (err) {
      setError(err.message || 'Failed to generate code');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  const handleDownloadCode = () => {
    const ext = language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js';
    const filename = `test-${Date.now()}.${ext}`;
    const blob = new Blob([generatedCode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const languageForPrism = language === 'typescript' ? 'typescript' : language === 'python' ? 'python' : 'javascript';

  return (
    <div className="code-generator-overlay" onClick={(e) => e.target.className === 'code-generator-overlay' && onClose()}>
      <div className="code-generator">
        <div className="code-generator-header">
          <h3>Generate Test Code</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="code-generator-error">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        <div className="code-generator-options">
          <div className="option-group">
            <label>Framework</label>
            <select value={framework} onChange={(e) => setFramework(e.target.value)}>
              <option value="playwright">Playwright</option>
              <option value="puppeteer">Puppeteer</option>
              <option value="selenium">Selenium</option>
            </select>
          </div>

          <div className="option-group">
            <label>Language</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="javascript">JavaScript</option>
              <option value="typescript">TypeScript</option>
              <option value="python">Python</option>
            </select>
          </div>

          <div className="option-group">
            <label>Test Framework</label>
            <select value={testFramework} onChange={(e) => setTestFramework(e.target.value)}>
              <option value="none">None (Plain script)</option>
              <option value="jest">Jest</option>
              <option value="mocha">Mocha</option>
              <option value="pytest">Pytest</option>
            </select>
          </div>
        </div>

        <div className="code-generator-actions">
          <div className="action-info">
            <span>{actions.length} actions recorded</span>
          </div>
          <div className="action-buttons">
            <button className="btn-secondary" onClick={handleCopyCode} disabled={!generatedCode}>
              {copied ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  Copy
                </>
              )}
            </button>
            <button className="btn-primary" onClick={handleDownloadCode} disabled={!generatedCode}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Download
            </button>
          </div>
        </div>

        <div className="code-generator-content">
          {loading ? (
            <div className="code-loading">
              <div className="spinner"></div>
              <p>Generating code...</p>
            </div>
          ) : generatedCode ? (
            <pre className="code-block">
              <code ref={codeRef} className={`language-${languageForPrism}`}>
                {generatedCode}
              </code>
            </pre>
          ) : (
            <div className="code-empty">
              <p>No code generated yet</p>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .code-generator-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10001;
        }

        .code-generator {
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          width: 900px;
          max-width: 95vw;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .code-generator-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .code-generator-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-secondary, #999);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          line-height: 1;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
          color: var(--text-primary, #d4d4d4);
        }

        .code-generator-error {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          background: rgba(239, 68, 68, 0.1);
          border-bottom: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
          font-size: 13px;
        }

        .code-generator-error button {
          background: none;
          border: none;
          color: #ef4444;
          font-size: 20px;
          cursor: pointer;
          padding: 0 8px;
        }

        .code-generator-options {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          padding: 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #252525);
        }

        .option-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .option-group label {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary, #999);
        }

        .option-group select {
          padding: 8px 12px;
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 6px;
          color: var(--text-primary, #d4d4d4);
          font-size: 14px;
          cursor: pointer;
        }

        .option-group select:hover {
          border-color: #3b82f6;
        }

        .option-group select:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }

        .code-generator-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .action-info {
          font-size: 13px;
          color: var(--text-secondary, #999);
        }

        .action-buttons {
          display: flex;
          gap: 8px;
        }

        .btn-primary, .btn-secondary {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border: 1px solid;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #2563eb;
        }

        .btn-secondary {
          background: transparent;
          border-color: var(--border-color, #3a3a3a);
          color: var(--text-primary, #d4d4d4);
        }

        .btn-secondary:hover:not(:disabled) {
          background: var(--bg-hover, #2a2a2a);
          border-color: #3b82f6;
        }

        .btn-primary:disabled, .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .code-generator-content {
          flex: 1;
          overflow: auto;
          background: #0d1117;
        }

        .code-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: 40px;
          color: var(--text-secondary, #999);
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid var(--border-color, #3a3a3a);
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 16px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .code-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: 40px;
          color: var(--text-secondary, #999);
        }

        .code-block {
          margin: 0;
          padding: 20px;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 13px;
          line-height: 1.6;
          overflow: auto;
        }

        .code-block code {
          font-family: inherit;
          color: #e6edf3;
        }
      `}</style>
    </div>
  );
}
