import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { Dropdown } from './Dropdown';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { AI_TYPE_OPTIONS, getAiDisplayLabel, getAiTypeOptions } from '../utils/aiProviders';

export function MobileStatusBar({
  sessionId,
  onImageUpload,
  onOpenHistory,
  viewMode = 'terminal',
  onToggleViewMode,
  isConnected = true,
  aiType = null,
  customAiProviders = [],
  onSelectAiType,
  onAddCustomAiCommand,
  onLaunchAi
}) {
  const [inputText, setInputText] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [micState, setMicState] = useState({
    isRecording: false,
    isChecking: false,
    isRequesting: false,
    isTranscribing: false,
    error: null
  });
  const inputRef = useRef(null);
  const aiMenuRef = useRef(null);
  const { sendToSession } = useTerminalSession();
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const { handleKeyDown: autocorrectKeyDown } = useAutocorrectInput(inputText, setInputText, autocorrectEnabled);
  const aiOptions = useMemo(() => getAiTypeOptions(customAiProviders), [customAiProviders]);
  const selectedAiOption = aiOptions.find((option) => option.id === aiType)
    ?? (aiType ? { id: aiType, label: getAiDisplayLabel(aiType, customAiProviders), color: '#38bdf8' } : null)
    ?? aiOptions[0]
    ?? AI_TYPE_OPTIONS[0];
  const aiLabel = aiType ? (selectedAiOption?.label || getAiDisplayLabel(aiType, customAiProviders)) : null;
  const canLaunchSelectedAi = Boolean(aiType && onLaunchAi);

  const sendToTerminal = useCallback(async (text) => {
    if (!sessionId || !text.trim()) return;
    const payload = text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\r`;

    try {
      await sendToSession?.(sessionId, payload);
      setInputText('');
      setIsExpanded(false);
    } catch (error) {
      console.error('Failed to send input to terminal:', error);
    }
  }, [sendToSession, sessionId]);

  const sendRawToTerminal = useCallback(async (text) => {
    if (!sessionId || !text) return;
    try {
      await sendToSession?.(sessionId, text);
    } catch (error) {
      console.error('Failed to send raw input to terminal:', error);
    }
  }, [sendToSession, sessionId]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    sendToTerminal(inputText);
  }, [inputText, sendToTerminal]);

  const handleKeyDown = useCallback((e) => {
    const handled = autocorrectKeyDown(e);
    if (handled) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToTerminal(inputText);
    } else if (e.key === 'Escape') {
      setIsExpanded(false);
      setInputText('');
    }
  }, [inputText, sendToTerminal, autocorrectKeyDown]);

  const handlePaste = useCallback(async (e) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;
    const imageFile = await getImageFileFromDataTransfer(clipboardData);

    if (!imageFile) return;

    e.preventDefault();
    e.stopPropagation();
    try {
      const path = await uploadScreenshot(imageFile);
      if (path) {
        await sendRawToTerminal(`${path} `);
      }
    } catch (error) {
      console.error('Failed to paste image in mobile input:', error);
    }
  }, [sendRawToTerminal]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => {
      if (!prev) {
        // Focusing after state update
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      return !prev;
    });
  }, []);

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

  const moreItems = [
    {
      label: viewMode === 'terminal' ? 'Reader View' : 'Terminal View',
      onClick: () => onToggleViewMode?.()
    },
    {
      label: autocorrectEnabled ? 'Disable Autocorrect' : 'Enable Autocorrect',
      onClick: toggleAutocorrect
    },
    {
      label: 'Upload Image',
      onClick: () => onImageUpload?.(),
      disabled: !onImageUpload
    },
    {
      label: 'Copy History',
      onClick: () => onOpenHistory?.(),
      disabled: !onOpenHistory
    }
  ];

  return (
    <div className={`mobile-status-bar ${isExpanded ? 'expanded' : ''} ${isMicRecording ? 'recording' : ''}`}>
      {isExpanded ? (
        <form className="mobile-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="mobile-terminal-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type or dictate..."
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <button
            type="submit"
            className="mobile-input-send"
            disabled={!inputText.trim()}
            aria-label="Send to terminal"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
          <button
            type="button"
            className="mobile-input-close"
            onClick={() => { setIsExpanded(false); setInputText(''); }}
            aria-label="Close input"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      ) : (
        <>
          {!isMicRecording && (
            <div className="mobile-status-left">
              <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
            </div>
          )}

          <div className={`mobile-status-right ${isMicRecording ? 'mic-recording-full' : ''}`}>
            {!isMicRecording && (
              <>
                {/* Type button */}
                <button
                  type="button"
                  className="mobile-input-toggle"
                  onClick={toggleExpanded}
                  aria-label="Open text input"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="9" x2="15" y2="9" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                  <span>Type</span>
                </button>

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
                <Dropdown
                  trigger={(
                    <button
                      type="button"
                      className="status-bar-btn"
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
                />
              </>
            )}

            {/* Mic buttons - local Whisper + Groq cloud */}
            <TerminalMicButton sessionId={sessionId} provider="local" inline onRecordingChange={setIsMicRecording} onStateChange={handleMicStateChange} />
            <TerminalMicButton sessionId={sessionId} provider="groq" inline onRecordingChange={setIsMicRecording} onStateChange={handleMicStateChange} />
            {micStatusText && (
              <span className={`mobile-mic-status${micState.error ? ' error' : ''}`}>
                {micStatusText}
              </span>
            )}
          </div>
        </>
      )}

      <style>{`
        .mobile-status-ai-controls {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .mobile-status-ai-selector,
        .mobile-status-ai-launch {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 32px;
          padding: 0 10px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          color: var(--text-secondary, #d5deea);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .mobile-status-ai-selector.active,
        .mobile-status-ai-selector:hover,
        .mobile-status-ai-launch:hover:not(:disabled) {
          border-color: rgba(99, 179, 237, 0.35);
          color: var(--text-primary, #fff);
          background: rgba(99, 179, 237, 0.08);
        }

        .mobile-status-ai-label {
          max-width: 86px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 600;
        }

        .mobile-status-ai-swatch {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
        }

        .mobile-status-ai-launch {
          min-width: 32px;
          justify-content: center;
          padding: 0;
        }

        .mobile-status-ai-launch.disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .mobile-status-ai-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          min-width: 196px;
          padding: 6px;
          background: rgba(13, 18, 28, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
          z-index: 40;
          backdrop-filter: blur(14px);
        }

        .mobile-status-ai-menu-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 38px;
          padding: 0 10px;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-secondary, #d5deea);
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
        }

        .mobile-status-ai-menu-item:hover,
        .mobile-status-ai-menu-item.selected {
          background: rgba(99, 179, 237, 0.1);
          color: var(--text-primary, #fff);
        }

        .mobile-status-ai-menu-label {
          flex: 1;
          font-size: 13px;
          font-weight: 550;
        }

        .mobile-status-ai-menu-add {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          margin-top: 6px;
          padding-top: 8px;
        }

        .mobile-status-ai-menu-plus {
          width: 16px;
          text-align: center;
          font-size: 14px;
          font-weight: 700;
          color: var(--accent-primary, #38bdf8);
        }
      `}</style>
    </div>
  );
}
