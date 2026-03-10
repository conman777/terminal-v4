import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { Dropdown } from './Dropdown';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { AI_TYPE_OPTIONS, getAiDisplayLabel, getAiTypeOptions } from '../utils/aiProviders';
import { getComposerSlashSuggestions } from '../utils/slashCommands';

export function MobileStatusBar({
  sessionId,
  onOpenHistory,
  viewMode = 'terminal',
  onToggleViewMode,
  aiType = null,
  customAiProviders = [],
  onSelectAiType,
  onAddCustomAiCommand,
  onLaunchAi,
  runtimeInfo = null,
  gitBranches = [],
  currentGitBranch = null,
  isLoadingGitBranches = false,
  isSwitchingGitBranch = false,
  onSelectGitBranch,
  composerPlaceholder = 'Ask V4 anything'
}) {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [isPastingImage, setIsPastingImage] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [micState, setMicState] = useState({
    isRecording: false,
    isChecking: false,
    isRequesting: false,
    isTranscribing: false,
    error: null
  });
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const aiMenuRef = useRef(null);
  const { sendToSession } = useTerminalSession();
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const { handleKeyDown: autocorrectKeyDown } = useAutocorrectInput(inputText, setInputText, autocorrectEnabled);
  const aiOptions = useMemo(() => getAiTypeOptions(customAiProviders), [customAiProviders]);
  const activeRuntimeProviderId = runtimeInfo?.providerId ?? null;
  const slashSuggestions = useMemo(
    () => getComposerSlashSuggestions(inputText, activeRuntimeProviderId),
    [activeRuntimeProviderId, inputText]
  );
  const selectedAiOption = aiOptions.find((option) => option.id === aiType)
    ?? (aiType ? { id: aiType, label: getAiDisplayLabel(aiType, customAiProviders), color: '#38bdf8' } : null)
    ?? aiOptions[0]
    ?? AI_TYPE_OPTIONS[0];
  const aiLabel = aiType ? (selectedAiOption?.label || getAiDisplayLabel(aiType, customAiProviders)) : null;
  const canLaunchSelectedAi = Boolean(aiType && onLaunchAi);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [inputText, slashSuggestions.length]);

  const sendToTerminal = useCallback(async (text, currentAttachments = attachments) => {
    if (!sessionId) return;
    const trimmed = String(text || '').trim();
    const attachmentPaths = currentAttachments
      .map((attachment) => attachment?.path)
      .filter((path) => typeof path === 'string' && path.trim());
    const payload = [attachmentPaths.join(' '), trimmed].filter(Boolean).join(' ').trim();
    if (!payload) return;

    try {
      await sendToSession?.(sessionId, payload.endsWith('\r') || payload.endsWith('\n') ? payload : `${payload}\r`);
      setInputText('');
      setAttachments([]);
    } catch (error) {
      console.error('Failed to send input to terminal:', error);
    }
  }, [attachments, sendToSession, sessionId]);

  const handleSubmit = useCallback((event) => {
    event.preventDefault();
    if (isPastingImage) return;
    void sendToTerminal(inputText);
  }, [inputText, isPastingImage, sendToTerminal]);

  const handleKeyDown = useCallback((event) => {
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
        void sendToTerminal(slashSuggestions[selectedSlashIndex].cmd);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        setInputText(`${slashSuggestions[selectedSlashIndex].cmd} `);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendToTerminal(inputText);
    }
  }, [autocorrectKeyDown, inputText, selectedSlashIndex, sendToTerminal, slashSuggestions]);

  const addAttachment = useCallback((attachment) => {
    if (!attachment?.path) return;
    setAttachments((previous) => [...previous, attachment]);
  }, []);

  const removeAttachment = useCallback((path) => {
    setAttachments((previous) => previous.filter((attachment) => attachment.path !== path));
  }, []);

  const handlePaste = useCallback(async (event) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    let imageFile = null;
    try {
      imageFile = await getImageFileFromDataTransfer(clipboardData);
    } catch (error) {
      console.error('Failed to inspect pasted image data for mobile composer:', error);
      return;
    }

    if (!imageFile) return;

    event.preventDefault();
    event.stopPropagation();
    setIsPastingImage(true);

    try {
      const path = await uploadScreenshot(imageFile);
      if (!path) return;
      addAttachment({
        name: imageFile.name || 'image.png',
        path
      });
    } catch (error) {
      console.error('Failed to paste image into mobile composer:', error);
    } finally {
      setIsPastingImage(false);
    }
  }, [addAttachment]);

  const handleImageSelect = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsPastingImage(true);
    try {
      const path = await uploadScreenshot(file);
      if (!path) return;
      addAttachment({
        name: file.name || 'image.png',
        path
      });
    } catch (error) {
      console.error('Failed to attach image from mobile composer picker:', error);
    } finally {
      setIsPastingImage(false);
    }
  }, [addAttachment]);

  const handleMicStateChange = useCallback((nextState) => {
    if (!nextState) return;
    setMicState(nextState);
  }, []);

  const micStatusText = useMemo(() => {
    if (micState.error) return micState.error;
    if (micState.isRequesting) return 'Allow microphone...';
    if (micState.isChecking) return 'Checking voice...';
    if (micState.isTranscribing) return 'Transcribing...';
    if (micState.isRecording) return 'Recording...';
    return '';
  }, [micState.error, micState.isChecking, micState.isRecording, micState.isRequesting, micState.isTranscribing]);

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

  const handleAiTypeSelect = useCallback((nextAiType) => {
    onSelectAiType?.(nextAiType);
    setIsAiMenuOpen(false);
  }, [onSelectAiType]);

  const handleAddCustomCommand = useCallback(() => {
    const label = window.prompt('Name this custom AI command');
    if (typeof label !== 'string' || !label.trim()) return;

    const command = window.prompt(`Launch command for ${label.trim()}`);
    if (typeof command !== 'string' || !command.trim()) return;

    onAddCustomAiCommand?.(label.trim(), command.trim());
    setIsAiMenuOpen(false);
  }, [onAddCustomAiCommand]);

  const canSubmit = !isPastingImage && (Boolean(inputText.trim()) || attachments.length > 0);
  const hasBranchContext = Boolean(gitBranches.length > 0 || currentGitBranch);

  const moreItems = [
    {
      label: viewMode === 'terminal' ? 'Reader view' : 'Terminal view',
      onClick: () => onToggleViewMode?.()
    },
    {
      label: autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect',
      onClick: toggleAutocorrect
    },
    {
      label: 'Upload image',
      onClick: () => imageInputRef.current?.click(),
      disabled: isPastingImage
    },
    {
      label: 'Copy history',
      onClick: () => onOpenHistory?.(),
      disabled: !onOpenHistory
    }
  ];

  return (
    <div className="mobile-status-bar mobile-composer-shell">
      {attachments.length > 0 && (
        <div className="mobile-composer-attachments" aria-label="Composer attachments">
          {attachments.map((attachment, index) => (
            <div key={`${attachment.path}-${index}`} className="mobile-composer-attachment-chip">
              <span className="mobile-composer-attachment-dot" aria-hidden="true" />
              <span className="mobile-composer-attachment-name" title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                className="mobile-composer-attachment-remove"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.path)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="mobile-composer-form" onSubmit={handleSubmit}>
        {slashSuggestions.length > 0 && (
          <div className="mobile-slash-menu" role="listbox" aria-label="Slash commands">
            {slashSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.cmd}
                type="button"
                role="option"
                aria-selected={index === selectedSlashIndex ? 'true' : 'false'}
                className={`mobile-slash-option${index === selectedSlashIndex ? ' selected' : ''}`}
                onClick={() => setInputText(`${suggestion.cmd} `)}
              >
                <span className="mobile-slash-command">{suggestion.cmd}</span>
                <span className="mobile-slash-description">{suggestion.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="mobile-composer-input"
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={composerPlaceholder}
          aria-label="Command composer"
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          disabled={isPastingImage}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="mobile-composer-image-input"
          onChange={handleImageSelect}
          tabIndex={-1}
          aria-hidden="true"
        />

        <div className="mobile-composer-controls">
          <div className="mobile-composer-primary">
            <div className="mobile-status-ai-controls" ref={aiMenuRef}>
              <button
                type="button"
                className={`mobile-status-ai-selector ${isAiMenuOpen ? 'active' : ''}`}
                onClick={() => setIsAiMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={isAiMenuOpen ? 'true' : 'false'}
                aria-label="Choose AI coder"
                title={`Assistant: ${selectedAiOption.label}`}
              >
                <span
                  className="mobile-status-ai-swatch"
                  style={{ backgroundColor: selectedAiOption.color ?? 'var(--accent-primary)' }}
                  aria-hidden="true"
                />
                <span className="mobile-status-ai-label">{selectedAiOption.label}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <button
                type="button"
                className={`mobile-status-ai-launch ${canLaunchSelectedAi ? '' : 'disabled'}`}
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
                <div className="mobile-status-ai-menu" role="menu" aria-label="AI coder options">
                  {aiOptions.map((option) => {
                    const isSelected = option.id === aiType || (!option.id && !aiType);
                    return (
                      <button
                        key={option.id ?? 'cli'}
                        type="button"
                        className={`mobile-status-ai-menu-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleAiTypeSelect(option.id)}
                        role="menuitemradio"
                        aria-checked={isSelected ? 'true' : 'false'}
                      >
                        <span
                          className="mobile-status-ai-swatch"
                          style={{ backgroundColor: option.color ?? 'var(--accent-primary)' }}
                          aria-hidden="true"
                        />
                        <span className="mobile-status-ai-menu-label">{option.label}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="mobile-status-ai-menu-item mobile-status-ai-menu-add"
                    onClick={handleAddCustomCommand}
                    role="menuitem"
                  >
                    <span className="mobile-status-ai-menu-plus" aria-hidden="true">+</span>
                    <span className="mobile-status-ai-menu-label">Add custom command</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className={`mobile-status-btn ${autocorrectEnabled ? 'active' : ''}`}
              onClick={toggleAutocorrect}
              aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
              title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
            >
              ABC
            </button>

            <button
              type="button"
              className="mobile-status-btn"
              onClick={() => imageInputRef.current?.click()}
              disabled={isPastingImage}
              aria-label="Upload image"
              title="Upload image"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>

            <TerminalMicButton sessionId={sessionId} provider="local" inline onStateChange={handleMicStateChange} />
            <TerminalMicButton sessionId={sessionId} provider="groq" inline onStateChange={handleMicStateChange} />

            <Dropdown
              trigger={(
                <button
                  type="button"
                  className="mobile-status-btn"
                  aria-label="More terminal actions"
                  title="More"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="12" cy="19" r="2" />
                  </svg>
                </button>
              )}
              items={moreItems}
              align="right"
              direction="up"
            />
          </div>

          <button
            type="submit"
            className={`mobile-composer-send ${canSubmit ? '' : 'disabled'}`}
            disabled={!canSubmit}
            aria-label="Send to terminal"
            title="Send to terminal"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3.4 20.4 21.85 12 3.4 3.6l.05 6.4 12.25 2-12.25 2-.05 6.4Z" />
            </svg>
          </button>
        </div>
      </form>

      {(runtimeInfo?.label || hasBranchContext || micStatusText) && (
        <div className="mobile-composer-footer" aria-label="Mobile composer context">
          <div className="mobile-composer-footer-left">
            {runtimeInfo?.label && (
              <span className="mobile-runtime-chip" title={runtimeInfo.label}>{runtimeInfo.label}</span>
            )}
            {micStatusText && (
              <span className={`mobile-runtime-chip${micState.error ? ' error' : ''}`}>{micStatusText}</span>
            )}
          </div>

          {hasBranchContext && (
            <div className="mobile-branch-picker" title={`Branch: ${currentGitBranch || ''}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {gitBranches.length > 0 && onSelectGitBranch ? (
                <Dropdown
                  align="right"
                  direction="up"
                  className="mobile-branch-dropdown"
                  trigger={(
                    <button
                      type="button"
                      className="mobile-branch-trigger"
                      disabled={isLoadingGitBranches || isSwitchingGitBranch}
                      aria-label="Select git branch"
                    >
                      <span className="mobile-branch-trigger-label">{currentGitBranch || 'No branch'}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  )}
                  items={gitBranches.map((branch) => ({
                    label: branch,
                    active: branch === currentGitBranch,
                    badge: branch === currentGitBranch ? 'Current' : null,
                    onClick: () => onSelectGitBranch(branch)
                  }))}
                />
              ) : (
                <span className="mobile-branch-fallback">{currentGitBranch || 'No branch'}</span>
              )}
            </div>
          )}
        </div>
      )}

      <style>{`
        .mobile-composer-shell {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          padding: 8px 10px calc(10px + env(safe-area-inset-bottom));
          border-top: 1px solid color-mix(in srgb, var(--border-default) 24%, transparent);
          background: var(--terminal-bg, #0b0f17);
          backdrop-filter: blur(18px);
        }

        .mobile-composer-form {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: min(100%, 880px);
          padding: 12px 12px 10px;
          border-radius: 16px;
          background: color-mix(in srgb, var(--bg-surface) 94%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-primary) 6%, transparent);
        }

        .mobile-composer-input {
          width: 100%;
          min-height: 52px;
          max-height: 132px;
          padding: 0;
          margin: 0;
          resize: none;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-family: var(--font-ui);
          font-size: 15px;
          font-weight: 500;
          line-height: 1.35;
          outline: none;
          box-shadow: none;
        }

        .mobile-composer-input::placeholder {
          color: color-mix(in srgb, var(--text-muted) 72%, transparent);
        }

        .mobile-composer-input:disabled {
          opacity: 0.72;
          cursor: progress;
        }

        .mobile-composer-image-input {
          display: none;
        }

        .mobile-slash-menu {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 6px;
          border-radius: 12px;
          background: color-mix(in srgb, var(--bg-base) 94%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 24%, transparent);
        }

        .mobile-slash-option {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          width: 100%;
          padding: 9px 10px;
          border: none;
          border-radius: 9px;
          background: transparent;
          color: var(--text-secondary, #d5deea);
          text-align: left;
          cursor: pointer;
        }

        .mobile-slash-option:hover,
        .mobile-slash-option.selected {
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
          color: var(--text-primary);
        }

        .mobile-slash-command {
          font-size: 12px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .mobile-slash-description {
          flex: 1;
          min-width: 0;
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
          text-align: right;
        }

        .mobile-composer-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding-top: 8px;
          border-top: 1px solid color-mix(in srgb, var(--border-default) 24%, transparent);
        }

        .mobile-composer-primary {
          display: flex;
          align-items: center;
          gap: 6px;
          flex: 1 1 auto;
          min-width: 0;
          flex-wrap: nowrap;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: none;
          -ms-overflow-style: none;
          padding-bottom: 1px;
        }

        .mobile-composer-primary::-webkit-scrollbar {
          display: none;
        }

        .mobile-status-ai-controls {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .mobile-status-ai-selector,
        .mobile-status-ai-launch,
        .mobile-status-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-height: 30px;
          padding: 0 9px;
          background: color-mix(in srgb, var(--bg-elevated) 84%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          border-radius: 9px;
          color: var(--text-secondary, #d5deea);
          cursor: pointer;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }

        .mobile-status-btn {
          min-width: 30px;
          padding: 0 8px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: -0.04em;
        }

        .mobile-status-ai-selector.active,
        .mobile-status-ai-selector:hover,
        .mobile-status-ai-launch:hover:not(:disabled),
        .mobile-status-btn:hover:not(:disabled) {
          border-color: color-mix(in srgb, var(--accent-primary) 38%, var(--border-default));
          color: var(--text-primary);
          background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
        }

        .mobile-status-ai-label {
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          font-weight: 600;
        }

        .mobile-status-ai-swatch {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 16%, transparent);
        }

        .mobile-status-ai-launch.disabled,
        .mobile-status-btn:disabled,
        .mobile-composer-send.disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .mobile-status-ai-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          min-width: 196px;
          padding: 6px;
          background: color-mix(in srgb, var(--bg-surface) 96%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 30%, transparent);
          border-radius: 12px;
          box-shadow: var(--shadow-modal);
          z-index: 40;
          backdrop-filter: blur(14px);
        }

        .mobile-status-ai-menu-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 34px;
          padding: 0 10px;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-secondary, #d5deea);
          cursor: pointer;
        }

        .mobile-status-ai-menu-item:hover,
        .mobile-status-ai-menu-item.selected {
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
          color: var(--text-primary);
        }

        .mobile-status-ai-menu-label {
          flex: 1;
          text-align: left;
          font-size: 12px;
          font-weight: 550;
        }

        .mobile-status-ai-menu-add {
          border-top: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          margin-top: 6px;
          padding-top: 8px;
        }

        .mobile-status-ai-menu-plus {
          width: 16px;
          text-align: center;
          font-size: 14px;
          font-weight: 700;
          color: var(--accent-primary);
        }

        .mobile-composer-send {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--border-default));
          background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated));
          color: var(--text-primary);
          cursor: pointer;
          flex-shrink: 0;
        }

        .mobile-composer-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          width: min(100%, 880px);
        }

        .mobile-composer-attachment-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          max-width: 180px;
          min-height: 26px;
          padding: 0 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          color: var(--text-primary);
        }

        .mobile-composer-attachment-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent-primary) 82%, white 6%);
          flex-shrink: 0;
        }

        .mobile-composer-attachment-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          font-weight: 600;
        }

        .mobile-composer-attachment-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          padding: 0;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--text-muted, #94a3b8);
          cursor: pointer;
          flex-shrink: 0;
        }

        .mobile-composer-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 20px;
          width: min(100%, 880px);
          padding: 0 2px;
          flex-wrap: nowrap;
        }

        .mobile-composer-footer-left {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
        }

        .mobile-runtime-chip {
          display: inline-flex;
          align-items: center;
          min-width: 0;
          max-width: 128px;
          color: color-mix(in srgb, var(--text-secondary) 76%, transparent);
          font-size: 10px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .mobile-runtime-chip.error {
          color: #fca5a5;
        }

        .mobile-branch-picker {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          color: color-mix(in srgb, var(--text-secondary) 88%, transparent);
          flex-shrink: 0;
        }

        .mobile-branch-dropdown .dropdown-menu {
          min-width: 220px;
          max-width: 280px;
          padding: 6px;
          border-radius: 12px;
          border: 1px solid color-mix(in srgb, var(--border-default) 28%, transparent);
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--bg-surface) 96%, transparent),
            color-mix(in srgb, var(--bg-base) 96%, transparent)
          );
          box-shadow: var(--shadow-modal);
        }

        .mobile-branch-dropdown .dropdown-item {
          min-height: 34px;
          padding: 0 10px;
          border-radius: 8px;
          color: color-mix(in srgb, var(--text-secondary) 92%, transparent);
          font-size: 12px;
          font-weight: 550;
        }

        .mobile-branch-dropdown .dropdown-item:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
          color: var(--text-primary);
        }

        .mobile-branch-dropdown .dropdown-item.active {
          background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
          color: var(--text-primary);
        }

        .mobile-branch-dropdown .dropdown-item-badge {
          color: color-mix(in srgb, var(--accent-primary) 84%, var(--text-primary));
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .mobile-branch-trigger {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 20px;
          padding: 0 2px;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }

        .mobile-branch-trigger-label,
        .mobile-branch-fallback {
          max-width: 92px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
