import { useEffect, useRef, useState } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { AI_TYPE_OPTIONS, getAiDisplayLabel } from '../utils/aiProviders';

/**
 * Desktop status bar at the bottom of the terminal pane.
 * Shows connection status, current directory, git branch, and action buttons.
 */
export function DesktopStatusBar({
  sessionId,
  sessionTitle,
  cwd,
  gitBranch,
  gitStats,
  onImageUpload,
  isTerminalPanelOpen = false,
  showTerminalToggle = true,
  onToggleTerminalPanel,
  aiType = null,
  aiOptions = AI_TYPE_OPTIONS,
  onSelectAiType,
  onAddCustomAiCommand,
  onLaunchAi,
  composerValue = '',
  onComposerChange,
  onComposerSubmit,
  composerPlaceholder = 'Send a command or prompt',
  composerDisabled = false
}) {
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const aiMenuRef = useRef(null);

  // Extract folder name from cwd, fall back to session title
  const normalizedCwd = typeof cwd === 'string' ? cwd.replace(/\\/g, '/') : '';
  const folderName = normalizedCwd ? normalizedCwd.split('/').filter(Boolean).pop() || normalizedCwd : '';
  const displayName = folderName || sessionTitle || '';
  const selectedAiOption = aiOptions.find((option) => option.id === aiType)
    ?? (aiType ? { id: aiType, label: getAiDisplayLabel(aiType), color: '#38bdf8' } : null)
    ?? aiOptions[0]
    ?? AI_TYPE_OPTIONS[0];
  const aiLabel = aiType ? (selectedAiOption?.label || getAiDisplayLabel(aiType)) : null;
  const canLaunchSelectedAi = Boolean(aiType && onLaunchAi);
  const hasGitStats = Boolean(gitStats && (gitStats.linesAdded > 0 || gitStats.linesRemoved > 0));
  const showMetaRow = Boolean(gitBranch || hasGitStats || showTerminalToggle);

  useEffect(() => {
    if (!isAiMenuOpen) return undefined;

    function handleOutsideClick(event) {
      if (aiMenuRef.current && !aiMenuRef.current.contains(event.target)) {
        setIsAiMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isAiMenuOpen]);

  function handleAiTypeSelect(nextAiType) {
    onSelectAiType?.(nextAiType);
    setIsAiMenuOpen(false);
  }

  function handleAddCustomCommand() {
    const label = window.prompt('Name this custom AI command');
    if (typeof label !== 'string' || !label.trim()) return;

    const command = window.prompt(`Launch command for ${label.trim()}`);
    if (typeof command !== 'string' || !command.trim()) return;

    onAddCustomAiCommand?.(label.trim(), command.trim());
    setIsAiMenuOpen(false);
  }

  function handleComposerSubmit(event) {
    event?.preventDefault?.();
    if (composerDisabled) return;
    if (!composerValue.trim()) return;
    onComposerSubmit?.(composerValue);
  }

  function handleComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleComposerSubmit(event);
    }
  }

  const canSubmitComposer = !composerDisabled && Boolean(composerValue.trim()) && typeof onComposerSubmit === 'function';

  return (
    <div className="desktop-status-bar desktop-status-bar-shell">
      {showMetaRow && (
        <div className="status-bar-meta-row">
          <div className="status-bar-left">
            {gitBranch && (
              <span className="status-git-branch" title={`Branch: ${gitBranch}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {gitBranch}
              </span>
            )}
            {hasGitStats && (
              <span className="status-git-stats" title={`${gitStats.linesAdded} additions, ${gitStats.linesRemoved} deletions`}>
                {gitStats.linesAdded > 0 && (
                  <span className="git-stat-added">+{gitStats.linesAdded.toLocaleString()}</span>
                )}
                {gitStats.linesRemoved > 0 && (
                  <span className="git-stat-removed">-{gitStats.linesRemoved.toLocaleString()}</span>
                )}
              </span>
            )}
          </div>

          <div className="status-bar-top-actions">
            {showTerminalToggle && (
              <button
                type="button"
                className={`status-terminal-toggle ${isTerminalPanelOpen ? 'active' : ''}`}
                onClick={onToggleTerminalPanel}
                disabled={!onToggleTerminalPanel}
                aria-label={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
                title={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
              >
                {isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
              </button>
            )}
          </div>
        </div>
      )}

      <form className={`status-composer-shell${composerDisabled ? ' disabled' : ''}`} onSubmit={handleComposerSubmit}>
        <textarea
          className="status-composer-input"
          value={composerValue}
          onChange={(event) => onComposerChange?.(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={composerPlaceholder}
          aria-label="Command composer"
          rows={1}
          disabled={composerDisabled}
        />

        <div className="status-bar-right">
        <div className="status-context-chips">
          {displayName && (
            <span className="status-cwd" title={cwd || sessionTitle}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              {displayName}
            </span>
          )}
          {aiLabel && (
            <span className="status-ai-chip ultra-minimal" title={`Assistant: ${aiLabel}`}>
              <span style={{width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--accent-primary)', opacity: 0.6}}></span>
              {aiLabel.toLowerCase()}
            </span>
          )}
        </div>
        <div className="status-ai-controls" ref={aiMenuRef}>
          <button
            type="button"
            className={`status-ai-selector ${isAiMenuOpen ? 'active' : ''}`}
            onClick={() => setIsAiMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isAiMenuOpen ? 'true' : 'false'}
            aria-label="Choose AI coder"
            title={`Assistant: ${selectedAiOption.label}`}
          >
            <span
              className="status-ai-swatch"
              style={{ backgroundColor: selectedAiOption.color ?? 'var(--accent-primary)' }}
              aria-hidden="true"
            />
            <span className="status-ai-selector-label">{selectedAiOption.label}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            type="button"
            className={`status-ai-launch ${canLaunchSelectedAi ? '' : 'disabled'}`}
            onClick={onLaunchAi}
            disabled={!canLaunchSelectedAi}
            aria-label={aiLabel ? `Launch ${aiLabel}` : 'Launch selected AI'}
            title={aiLabel ? `Launch ${aiLabel}` : 'Select an AI coder first'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="8 5 19 12 8 19 8 5" />
            </svg>
          </button>
          {isAiMenuOpen && (
            <div className="status-ai-menu" role="menu" aria-label="AI coder options">
              {aiOptions.map((option) => {
                const isSelected = option.id === aiType || (!option.id && !aiType);
                return (
                  <button
                    key={option.id ?? 'cli'}
                    type="button"
                    className={`status-ai-menu-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleAiTypeSelect(option.id)}
                    role="menuitemradio"
                    aria-checked={isSelected ? 'true' : 'false'}
                  >
                    <span
                      className="status-ai-swatch"
                      style={{ backgroundColor: option.color ?? 'var(--accent-primary)' }}
                      aria-hidden="true"
                    />
                    <span className="status-ai-menu-label">{option.label}</span>
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                className="status-ai-menu-item status-ai-menu-add"
                onClick={handleAddCustomCommand}
                role="menuitem"
              >
                <span className="status-ai-menu-plus" aria-hidden="true">+</span>
                <span className="status-ai-menu-label">Add custom command</span>
              </button>
            </div>
          )}
        </div>

        {/* Autocorrect toggle button */}
        <button
          type="button"
          className={`status-bar-btn ${autocorrectEnabled ? 'active' : ''}`}
          onClick={toggleAutocorrect}
          aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
          title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
        >
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>ABC</span>
        </button>

        {/* Image upload button */}
        <button
          type="button"
          className="status-bar-btn"
          onClick={onImageUpload}
          disabled={!onImageUpload}
          aria-label="Upload image"
          title="Upload image"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>

        {/* Mic buttons - local Whisper + Groq cloud */}
        <TerminalMicButton sessionId={sessionId} provider="local" inline />
        <TerminalMicButton sessionId={sessionId} provider="groq" inline />
        <button
          type="submit"
          className={`status-send-btn ${canSubmitComposer ? '' : 'disabled'}`}
          disabled={!canSubmitComposer}
          aria-label="Send to terminal"
          title="Send to terminal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3.4 20.4 21.85 12 3.4 3.6l.05 6.4 12.25 2-12.25 2-.05 6.4Z" />
          </svg>
        </button>
        </div>
      </form>

      <style>{`
        .desktop-status-bar-shell {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: flex-start;
          gap: 10px;
          height: auto;
          min-height: 132px;
          padding: 8px 18px 18px;
          background: transparent;
          border-top: none;
        }

        .status-bar-meta-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          max-width: 880px;
          width: 100%;
          margin: 0 auto;
        }

        .status-bar-top-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .desktop-status-bar-shell .status-bar-left {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          flex-wrap: wrap;
          min-width: 0;
          overflow: visible;
        }

        .status-composer-shell {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-width: 880px;
          width: 100%;
          margin: 0 auto;
          padding: 16px 18px 12px;
          border-radius: 20px;
          background:
            linear-gradient(180deg, rgba(16, 21, 31, 0.96), rgba(11, 15, 23, 0.98));
          border: 1px solid rgba(255, 255, 255, 0.05);
          box-shadow:
            0 18px 40px rgba(0, 0, 0, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.025);
        }

        .status-composer-shell.disabled {
          opacity: 0.7;
        }

        .status-composer-shell:focus-within {
          border-color: rgba(255, 255, 255, 0.05);
          box-shadow:
            0 18px 40px rgba(0, 0, 0, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.025);
        }

        .status-composer-input {
          width: 100%;
          min-height: 62px;
          max-height: 180px;
          resize: none;
          padding: 0;
          margin: 0;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font: inherit;
          font-size: 16px;
          line-height: 1.45;
          appearance: none;
          -webkit-appearance: none;
          outline: none;
          box-shadow: none;
        }

        .status-composer-input:focus,
        .status-composer-input:focus-visible,
        .status-composer-input:active {
          outline: none !important;
          border: none !important;
          box-shadow: none !important;
        }

        .status-composer-input::placeholder {
          color: rgba(255, 255, 255, 0.34);
        }

        .status-ai-controls {
          position: relative;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .status-bar-right {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          padding-top: 10px;
          border-top: 1px solid rgba(148, 163, 184, 0.12);
        }

        .status-context-chips {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          min-width: 0;
        }

        .desktop-status-bar-shell .terminal-mic-inline-container {
          display: inline-flex;
        }

        .status-ai-selector,
        .status-ai-launch {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 26px;
          padding: 0 9px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 7px;
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .status-ai-selector:hover,
        .status-ai-selector.active,
        .status-ai-launch:hover:not(:disabled) {
          border-color: rgba(99, 179, 237, 0.35);
          color: var(--text-primary);
          background: rgba(99, 179, 237, 0.08);
        }

        .status-ai-selector-label {
          max-width: 104px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          font-weight: 600;
        }

        .status-ai-swatch {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
        }

        .status-ai-launch {
          justify-content: center;
          min-width: 26px;
          padding: 0;
        }

        .status-ai-launch.disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .status-ai-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 8px);
          min-width: 200px;
          padding: 6px;
          background: rgba(13, 18, 28, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
          z-index: 30;
          backdrop-filter: blur(14px);
        }

        .status-ai-menu-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 34px;
          padding: 0 10px;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-secondary);
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
        }

        .status-ai-menu-item:hover,
        .status-ai-menu-item.selected {
          background: rgba(99, 179, 237, 0.1);
          color: var(--text-primary);
        }

        .status-ai-menu-label {
          flex: 1;
          font-size: 12px;
          font-weight: 550;
        }

        .status-ai-menu-add {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          margin-top: 6px;
          padding-top: 8px;
        }

        .status-ai-menu-plus {
          width: 16px;
          text-align: center;
          font-size: 14px;
          font-weight: 700;
          color: var(--accent-primary);
        }

        .status-send-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 1px solid rgba(99, 179, 237, 0.24);
          background: rgba(99, 179, 237, 0.14);
          color: #dbeafe;
          cursor: pointer;
          transition: all 0.15s ease;
          margin-left: auto;
        }

        .status-send-btn:hover:not(:disabled) {
          background: rgba(99, 179, 237, 0.22);
          border-color: rgba(99, 179, 237, 0.4);
          transform: translateY(-1px);
        }

        .status-send-btn.disabled,
        .status-send-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          transform: none;
        }

        @media (max-width: 1120px) {
          .desktop-status-bar-shell {
            min-height: 144px;
            padding: 8px 16px 16px;
          }

          .status-bar-meta-row,
          .status-composer-shell {
            max-width: none;
          }

          .status-bar-right {
            justify-content: flex-start;
          }
        }
      `}</style>
    </div>
  );
}
