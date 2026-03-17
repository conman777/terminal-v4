import { useEffect, useMemo, useRef, useState } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { Dropdown } from './Dropdown';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { AI_TYPE_OPTIONS, getAiDisplayLabel } from '../utils/aiProviders';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { getComposerSlashSuggestions } from '../utils/slashCommands';

function formatSessionSummary(summary) {
  if (typeof summary !== 'string') return '';
  const text = summary.trim();
  if (!text) return '';

  const pathStart = text.search(/(~[\\/]|[A-Za-z]:[\\/]|\/)/);
  if (pathStart === -1) return text;

  const prefix = text.slice(0, pathStart).trimEnd();
  const rawPath = text.slice(pathStart).trim();
  const isWindowsLike = /[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('~\\') || rawPath.includes('\\');
  const separator = isWindowsLike ? '\\' : '/';
  const normalizedPath = rawPath.replace(/[\\/]+/g, separator);
  const parts = normalizedPath.split(separator).filter(Boolean);

  if (parts.length <= 3) return text;

  let root = parts[0];
  let tailParts = parts.slice(-2);
  if (rawPath.startsWith('~')) {
    root = '~';
    tailParts = parts.slice(-2);
  } else if (/^[A-Za-z]:$/.test(root)) {
    tailParts = parts.slice(-2);
  }

  const compactPath = `${root}${separator}...${separator}${tailParts.join(separator)}`;
  return prefix ? `${prefix} ${compactPath}` : compactPath;
}

/**
 * Desktop status bar at the bottom of the terminal pane.
 * Shows connection status, current directory, git branch, and action buttons.
 */
export function DesktopStatusBar({
  sessionId,
  sessionTitle,
  sessionSummary = '',
  cwd,
  gitBranch,
  isActive = false,
  isTerminalPanelOpen = false,
  showTerminalToggle = true,
  onToggleTerminalPanel,
  aiType = null,
  aiOptions = AI_TYPE_OPTIONS,
  onSelectAiType,
  onAddCustomAiCommand,
  composerValue = '',
  composerAttachments = [],
  onComposerChange,
  onComposerSubmit,
  onComposerAttachmentAdd,
  onComposerAttachmentRemove,
  runtimeInfo = null,
  gitBranches = [],
  currentGitBranch = null,
  isLoadingGitBranches = false,
  isSwitchingGitBranch = false,
  onSelectGitBranch,
  composerPlaceholder = 'Send a command or prompt',
  composerDisabled = false
}) {
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const {
    handleKeyDown: autocorrectKeyDown,
    handleSelectionChange: handleAutocorrectSelectionChange
  } = useAutocorrectInput(
    composerValue,
    (nextValue) => onComposerChange?.(typeof nextValue === 'function' ? nextValue(composerValue) : nextValue),
    autocorrectEnabled
  );
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [isPastingImage, setIsPastingImage] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const aiMenuRef = useRef(null);
  const imageInputRef = useRef(null);

  // Extract folder name from cwd, fall back to session title
  const normalizedCwd = typeof cwd === 'string' ? cwd.replace(/\\/g, '/') : '';
  const folderName = normalizedCwd ? normalizedCwd.split('/').filter(Boolean).pop() || normalizedCwd : '';
  const selectedAiOption = aiOptions.find((option) => option.id === aiType)
    ?? (aiType ? { id: aiType, label: getAiDisplayLabel(aiType), color: '#38bdf8' } : null)
    ?? aiOptions[0]
    ?? AI_TYPE_OPTIONS[0];
  const showMetaRow = Boolean(showTerminalToggle);
  const showComposerFooter = Boolean(runtimeInfo?.label || currentGitBranch || gitBranch);
  const activeRuntimeProviderId = runtimeInfo?.providerId ?? null;
  const slashSuggestions = useMemo(
    () => getComposerSlashSuggestions(composerValue, activeRuntimeProviderId),
    [activeRuntimeProviderId, composerValue]
  );

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [composerValue, slashSuggestions.length]);

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
    if (!composerValue.trim() && composerAttachments.length === 0) return;
    onComposerSubmit?.(composerValue);
  }

  function handleComposerTranscript(transcribedText) {
    if (composerDisabled || typeof onComposerChange !== 'function') return;
    const normalizedTranscript = typeof transcribedText === 'string' ? transcribedText.trim() : '';
    if (!normalizedTranscript) return;

    const needsSeparator = Boolean(composerValue) && !/\s$/.test(composerValue);
    onComposerChange(`${composerValue}${needsSeparator ? ' ' : ''}${normalizedTranscript}`);
  }

  function handleGitBranchChange(event) {
    const nextBranch = typeof event === 'string' ? event : event?.target?.value;
    if (!nextBranch) return;
    onSelectGitBranch?.(nextBranch);
  }

  function handleComposerKeyDown(event) {
    const handled = autocorrectKeyDown(event);
    if (handled) return;

    if (slashSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onComposerSubmit?.(slashSuggestions[selectedSlashIndex].cmd);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        onComposerChange?.(`${slashSuggestions[selectedSlashIndex].cmd} `);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleComposerSubmit(event);
    }
  }

  async function handleComposerPaste(event) {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    let imageFile = null;
    try {
      imageFile = await getImageFileFromDataTransfer(clipboardData);
    } catch (error) {
      console.error('Failed to inspect pasted image data for composer:', error);
      return;
    }

    if (!imageFile) return;

    event.preventDefault();
    event.stopPropagation();
    setIsPastingImage(true);

    try {
      const path = await uploadScreenshot(imageFile);
      if (!path) return;
      onComposerAttachmentAdd?.({
        name: imageFile.name || 'image.png',
        path
      });
    } catch (error) {
      console.error('Failed to paste image into composer:', error);
    } finally {
      setIsPastingImage(false);
    }
  }

  async function handleImageSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsPastingImage(true);
    try {
      const path = await uploadScreenshot(file);
      if (!path) return;
      onComposerAttachmentAdd?.({
        name: file.name || 'image.png',
        path
      });
    } catch (error) {
      console.error('Failed to attach image from composer picker:', error);
    } finally {
      setIsPastingImage(false);
    }
  }

  const canSubmitComposer = !composerDisabled
    && (Boolean(composerValue.trim()) || composerAttachments.length > 0)
    && typeof onComposerSubmit === 'function';

  return (
    <div className={`desktop-status-bar desktop-status-bar-shell${isActive ? ' pane-active' : ''}`}>
      {showMetaRow && (
        <div className="status-bar-meta-row">
          <div className="status-bar-left" />

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
        {composerAttachments.length > 0 && (
          <div className="status-composer-attachments" aria-label="Composer attachments">
            {composerAttachments.map((attachment, index) => (
              <div key={`${attachment.path}-${index}`} className="status-composer-attachment-chip">
                <span className="status-composer-attachment-dot" aria-hidden="true" />
                <span className="status-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  className="status-composer-attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onComposerAttachmentRemove?.(attachment.path)}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
        {slashSuggestions.length > 0 && (
          <div className="status-slash-menu" role="listbox" aria-label="Slash commands">
            {slashSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.cmd}
                type="button"
                role="option"
                aria-selected={index === selectedSlashIndex ? 'true' : 'false'}
                className={`status-slash-option${index === selectedSlashIndex ? ' selected' : ''}`}
                onClick={() => onComposerChange?.(`${suggestion.cmd} `)}
              >
                <span className="status-slash-command">{suggestion.cmd}</span>
                <span className="status-slash-description">{suggestion.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          className="status-composer-input"
          value={composerValue}
          onChange={(event) => onComposerChange?.(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          onSelect={handleAutocorrectSelectionChange}
          onPaste={handleComposerPaste}
          placeholder={composerPlaceholder}
          aria-label="Command composer"
          rows={1}
          autoComplete="off"
          autoCorrect={autocorrectEnabled ? 'on' : 'off'}
          autoCapitalize={autocorrectEnabled ? 'sentences' : 'off'}
          spellCheck={autocorrectEnabled}
          disabled={composerDisabled || isPastingImage}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="status-composer-image-input"
          onChange={handleImageSelect}
          tabIndex={-1}
          aria-hidden="true"
        />

        <div className="status-bar-right">
        <button
          type="button"
          className="status-bar-btn"
          onClick={() => imageInputRef.current?.click()}
          disabled={composerDisabled || isPastingImage}
          aria-label="Add image"
          title="Add image"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
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

        {/* Mic buttons - local Whisper + Groq cloud */}
        <TerminalMicButton
          sessionId={sessionId}
          provider="local"
          inline
          disabled={composerDisabled || isPastingImage}
          onTranscript={handleComposerTranscript}
        />
        <TerminalMicButton
          sessionId={sessionId}
          provider="groq"
          inline
          disabled={composerDisabled || isPastingImage}
          onTranscript={handleComposerTranscript}
        />
        <button
          type="submit"
          className={`status-send-btn ${canSubmitComposer ? '' : 'disabled'}`}
          disabled={!canSubmitComposer}
          aria-label="Send to terminal"
          title="Send to terminal"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{transform: 'translate(1px, -1px)'}}>
            <path d="M3.4 20.4 21.85 12 3.4 3.6l.05 6.4 12.25 2-12.25 2-.05 6.4Z" />
          </svg>
        </button>
        </div>
      </form>
      {showComposerFooter && (
        <div className="status-composer-footer-row" aria-label="Git context">
          <span className="status-composer-footer-spacer" aria-hidden="true" />
          <div className="status-runtime-meta">
            {runtimeInfo?.label && (
              <span className="status-runtime-chip" title={runtimeInfo.label}>
                {runtimeInfo.label}
              </span>
            )}
            {sessionSummary && (
              <span className="status-session-summary" title={sessionSummary}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span className="status-session-summary-label">{formatSessionSummary(sessionSummary.toLowerCase())}</span>
              </span>
            )}
            {(gitBranches.length > 0 || currentGitBranch || gitBranch) && (
              <div className="status-branch-picker" title={`Branch: ${currentGitBranch || gitBranch || ''}`}>
                <span className="status-branch-glyph" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </span>
                {gitBranches.length > 0 && onSelectGitBranch ? (
                  <Dropdown
                    align="right"
                    direction="up"
                    className="status-branch-dropdown"
                    trigger={(
                      <button
                        type="button"
                        className="status-branch-trigger"
                        disabled={isLoadingGitBranches || isSwitchingGitBranch}
                        aria-label="Select git branch"
                      >
                        <span className="status-branch-trigger-label">
                          {currentGitBranch || gitBranch || 'No branch'}
                        </span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    )}
                    items={gitBranches.map((branch) => ({
                      label: branch,
                      active: branch === (currentGitBranch || gitBranch || ''),
                      badge: branch === (currentGitBranch || gitBranch || '') ? 'Current' : null,
                      onClick: () => handleGitBranchChange(branch)
                    }))}
                  />
                ) : (
                  <span className="status-branch-fallback">{currentGitBranch || gitBranch || 'No branch'}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .desktop-status-bar-shell {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: flex-start;
          flex-shrink: 0;
          position: relative;
          z-index: 3;
          gap: 8px;
          height: auto;
          min-height: 120px;
          padding: 8px 18px 14px;
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
          border-radius: 18px;
          background:
            linear-gradient(
              180deg,
              color-mix(in srgb, var(--bg-surface) 92%, transparent),
              color-mix(in srgb, var(--terminal-bg) 96%, transparent)
            );
          border: 1px solid color-mix(in srgb, var(--border-default) 38%, transparent);
          box-shadow:
            var(--shadow-lg),
            inset 0 1px 0 color-mix(in srgb, var(--text-primary) 6%, transparent);
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }

        .status-composer-shell.disabled {
          opacity: 0.7;
        }

        .status-composer-footer-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          max-width: 880px;
          width: 100%;
          margin: -2px auto 0;
          padding: 0 4px;
        }

        .status-composer-shell:focus-within {
          border-color: color-mix(in srgb, var(--border-default) 38%, transparent);
          box-shadow:
            var(--shadow-lg),
            inset 0 1px 0 color-mix(in srgb, var(--text-primary) 6%, transparent);
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
          font-family: var(--font-ui);
          font-size: 15px;
          font-weight: 500;
          letter-spacing: -0.015em;
          line-height: 1.35;
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
          color: color-mix(in srgb, var(--text-muted) 72%, transparent);
          font-weight: 500;
        }

        .status-composer-image-input {
          display: none;
        }

        .status-composer-input:disabled {
          cursor: progress;
          opacity: 0.78;
        }

        .status-composer-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .status-slash-menu {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 6px;
          border-radius: 14px;
          background: color-mix(in srgb, var(--bg-base) 92%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 24%, transparent);
        }

        .status-slash-option {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          width: 100%;
          padding: 10px 12px;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--text-secondary);
          text-align: left;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }

        .status-slash-option:hover,
        .status-slash-option.selected {
          background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
          color: var(--text-primary);
        }

        .status-slash-command {
          font-size: 13px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .status-slash-description {
          flex: 1;
          min-width: 0;
          font-size: 12px;
          color: var(--text-muted);
          text-align: right;
        }

        .status-composer-attachment-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: 220px;
          min-height: 30px;
          padding: 0 10px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          color: var(--text-primary);
        }

        .status-composer-attachment-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent-primary) 82%, white 6%);
          flex-shrink: 0;
        }

        .status-composer-attachment-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 600;
        }

        .status-composer-attachment-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          padding: 0;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          flex-shrink: 0;
          transition: all 0.15s ease;
        }

        .status-composer-attachment-remove:hover {
          background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
          color: var(--text-primary);
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
          justify-content: flex-start;
          gap: 10px;
          flex-wrap: wrap;
          padding: 8px 0 2px;
          border-top: 1px solid color-mix(in srgb, var(--border-default) 24%, transparent);
          transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        }

        .desktop-status-bar-shell.pane-active .status-composer-shell {
          background:
            linear-gradient(
              180deg,
              color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 12%),
              color-mix(in srgb, var(--terminal-bg) 96%, transparent)
            );
          border-color: color-mix(in srgb, var(--accent-primary) 26%, var(--border-default));
          box-shadow:
            var(--shadow-lg),
            inset 0 1px 0 color-mix(in srgb, var(--text-primary) 7%, transparent),
            inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 10%, transparent);
        }

        .desktop-status-bar-shell.pane-active .status-bar-right {
          border-top-color: color-mix(in srgb, var(--border-default) 24%, transparent);
          background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
          border-radius: 12px;
          padding: 8px 12px 2px;
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 10%, transparent);
        }

        .status-composer-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          min-height: 18px;
          color: var(--text-muted);
        }

        .status-composer-footer-spacer {
          flex: 1 1 auto;
          min-width: 12px;
        }

        .status-runtime-meta {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
          flex-wrap: wrap;
          margin-left: auto;
        }

        .status-composer-footer .status-git-branch {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--text-muted);
        }

        .status-runtime-chip {
          display: inline-flex;
          align-items: center;
          max-width: 260px;
          padding: 0;
          min-height: 20px;
          border-radius: 0;
          background: transparent;
          border: none;
          color: color-mix(in srgb, var(--text-secondary) 76%, transparent);
          font-size: 11px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .status-session-summary {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          max-width: 320px;
          color: color-mix(in srgb, var(--text-secondary) 82%, transparent);
          font-size: 11px;
          font-weight: 500;
        }

        .status-session-summary-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .status-branch-picker {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 20px;
          padding: 0;
          border-radius: 0;
          background: transparent;
          border: none;
          color: color-mix(in srgb, var(--text-secondary) 88%, transparent);
        }

        .status-branch-glyph {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          color: color-mix(in srgb, var(--text-primary) 76%, transparent);
          flex-shrink: 0;
        }

        .status-branch-select {
          min-width: 92px;
          max-width: 168px;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          outline: none;
          cursor: pointer;
        }

        .status-branch-select:disabled {
          cursor: progress;
          opacity: 0.72;
        }

        .status-branch-dropdown {
          display: inline-flex;
        }

        .status-branch-dropdown .dropdown-menu {
          min-width: 240px;
          max-width: 320px;
          padding: 6px;
          border-radius: 12px;
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--bg-surface) 96%, transparent),
            color-mix(in srgb, var(--bg-base) 96%, transparent)
          );
          box-shadow: var(--shadow-modal);
          backdrop-filter: blur(16px);
        }

        .status-branch-dropdown .dropdown-item {
          min-height: 34px;
          padding: 0 10px;
          border-radius: 8px;
          color: color-mix(in srgb, var(--text-secondary) 92%, transparent);
          font-size: 12px;
          font-weight: 550;
        }

        .status-branch-dropdown .dropdown-item:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
          color: var(--text-primary);
        }

        .status-branch-dropdown .dropdown-item.active {
          background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
          color: var(--text-primary);
        }

        .status-branch-dropdown .dropdown-item-badge {
          color: color-mix(in srgb, var(--accent-primary) 84%, var(--text-primary));
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .status-branch-trigger {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 24px;
          padding: 0 8px;
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          border-radius: 8px;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
        }

        .status-branch-trigger:hover:not(:disabled) {
          border-color: color-mix(in srgb, var(--accent-primary) 38%, var(--border-default));
          background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
          color: var(--text-primary);
        }

        .status-branch-trigger:disabled {
          cursor: progress;
          opacity: 0.72;
        }

        .status-branch-trigger-label,
        .status-branch-fallback {
          min-width: 0;
          max-width: 168px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .desktop-status-bar-shell .terminal-mic-inline-container {
          display: inline-flex;
        }

        .status-ai-selector {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 26px;
          padding: 0 9px;
          background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          border-radius: 7px;
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .status-ai-selector:hover,
        .status-ai-selector.active {
          border-color: color-mix(in srgb, var(--accent-primary) 36%, var(--border-default));
          color: var(--text-primary);
          background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
        }

        .desktop-status-bar-shell.pane-active .status-ai-selector,
        .desktop-status-bar-shell.pane-active .status-bar-btn,
        .desktop-status-bar-shell.pane-active .terminal-mic-button-inline,
        .desktop-status-bar-shell.pane-active .status-send-btn {
          border-color: color-mix(in srgb, var(--accent-primary) 28%, var(--border-default));
          background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
        }

        .desktop-status-bar-shell.pane-active .status-ai-selector,
        .desktop-status-bar-shell.pane-active .status-bar-btn,
        .desktop-status-bar-shell.pane-active .terminal-mic-button-inline {
          color: color-mix(in srgb, var(--text-primary) 94%, transparent);
        }

        .desktop-status-bar-shell.pane-active .status-branch-glyph {
          color: color-mix(in srgb, var(--text-primary) 84%, transparent);
        }

        .desktop-status-bar-shell.pane-active .status-ai-selector:hover,
        .desktop-status-bar-shell.pane-active .status-ai-selector.active,
        .desktop-status-bar-shell.pane-active .status-bar-btn:hover:not(:disabled),
        .desktop-status-bar-shell.pane-active .terminal-mic-button-inline:hover:not(:disabled) {
          border-color: color-mix(in srgb, var(--accent-primary) 36%, var(--border-default));
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
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
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 16%, transparent);
        }

        .status-ai-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 8px);
          min-width: 200px;
          padding: 6px;
          background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 30%, transparent);
          border-radius: 10px;
          box-shadow: var(--shadow-modal);
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
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
          color: var(--text-primary);
        }

        .status-ai-menu-label {
          flex: 1;
          font-size: 12px;
          font-weight: 550;
        }

        .status-ai-menu-add {
          border-top: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          margin-top: 6px;
          padding-top: 8px;
        }

        .status-terminal-toggle {
          min-height: 34px;
          padding: 0 12px;
          border-radius: 14px;
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--bg-elevated) 90%, transparent),
            color-mix(in srgb, var(--bg-surface) 92%, transparent)
          );
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
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
          border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--border-default));
          background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated));
          color: var(--text-primary);
          cursor: pointer;
          transition: all 0.15s ease;
          margin-left: auto;
          align-self: center;
          position: relative;
          top: -1px;
        }

        .status-send-btn svg {
          display: block;
        }

        .status-send-btn:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent-primary) 22%, var(--bg-elevated));
          border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-default));
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
