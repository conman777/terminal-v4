import { useRef, useState, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { TerminalMicButton } from './TerminalMicButton';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { apiFetch } from '../utils/api';
import { useConversationScroll } from '../hooks/useConversationScroll';
import { COMMON_LAUNCH_PREFIXES, getAiDisplayLabel, normalizeAiType } from '../utils/aiProviders';
import { quoteTerminalPath } from '../utils/mobileTerminalInput';
import './MobileChatView.css';

const CODEX_MODEL_RE = /\bgpt-5(?:\.\d+)?\b/i;

function SparkleIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z" />
    </svg>
  );
}

function compactText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function visibleContentFingerprint(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function echoChunkFingerprint(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function looksLikeSourceCodeLine(line) {
  return /\b(?:const|let|var|function|return|export|import|if)\b/.test(line)
    || /(?:=>|\.match\(|\.test\(|\/\*|\*\/)/.test(line);
}

function isLaunchCommand(content, aiType) {
  const normalized = String(content || '').trim().toLowerCase();
  if (!normalized) return false;

  const firstToken = normalized.split(/\s+/, 1)[0];
  if (COMMON_LAUNCH_PREFIXES.includes(firstToken)) return true;

  const normalizedAiType = normalizeAiType(aiType);
  return Boolean(normalizedAiType && (normalized === normalizedAiType || normalized.startsWith(`${normalizedAiType} `)));
}

function isSlashCommandOnlyTurn(content) {
  return /^\/[a-z0-9._:-]+$/i.test(String(content || '').trim());
}

function isShortFragmentTurn(content) {
  return /^[a-z]{1,2}$/i.test(String(content || '').trim());
}

function looksLikeWrappedPromptEcho(content, recentUserContent) {
  if (!recentUserContent) return false;

  const lines = String(content || '')
    .split('\n')
    .map((line) => normalizeTranscriptLine(line))
    .filter(Boolean);
  if (lines.length === 0) return false;

  const allChunky = lines.every((line) => line.length <= 8 && !/[.!?]$/.test(line));
  if (!allChunky) return false;

  const promptFingerprint = echoChunkFingerprint(recentUserContent);
  const echoFingerprint = echoChunkFingerprint(lines.join(''));
  return echoFingerprint.length >= 3 && promptFingerprint.length >= 8 && promptFingerprint.includes(echoFingerprint);
}

function looksLikeCodexStartupLine(line, squashed) {
  return (
    squashed.includes('openaicodex(v')
    || squashed.includes('bootingmcpserver')
    || squashed.includes('new2xrationlimitsuntil')
    || (CODEX_MODEL_RE.test(line) && (squashed.includes('100%left') || /\b(?:xhigh|high|medium|low)\b/i.test(line)))
    || (squashed.includes('model:') && squashed.includes('/modeltochange') && squashed.includes('100%left'))
  );
}

function looksLikeModelStatusFooter(line, squashed) {
  return (
    (line.includes('|') || /[🪟💰🔥🧠]/u.test(line))
    && (
      squashed.includes('opus4.6')
      || squashed.includes('sonnet4.6')
      || squashed.includes('claudemax')
      || CODEX_MODEL_RE.test(line)
      || squashed.includes('session/')
      || squashed.includes('today/')
      || squashed.includes('/hr')
      || squashed.includes('%left')
      || /\$\d/.test(line)
    )
  );
}

function stripModelStatusFooter(line) {
  return line
    .replace(/\s+(?:[|│]\s*)?(?:[🪟💰🔥🧠]\s*)?(?:Opus 4\.6|Sonnet 4\.6|gpt-5(?:\.\d+)?)\b[\s\S]*$/i, '')
    .trim();
}

function sanitizeAssistantContent(content, aiType) {
  const lines = String(content || '').split('\n');
  const normalizedLines = [];

  for (const rawLine of lines) {
    let trimmed = rawLine.trim();
    if (!trimmed) continue;

    trimmed = stripModelStatusFooter(trimmed);
    if (!trimmed) continue;

    const squashed = compactText(trimmed);
    if (/^\s*[>❯]\s*$/.test(trimmed)) continue;
    if (squashed.includes('microsoftwindows[version')) continue;
    if (squashed.includes('microsoftcorporation.allrightsreserved')) continue;
    if (squashed.includes('use/skillstolistavailableskills')) continue;
    if (looksLikeModelStatusFooter(trimmed, squashed)) continue;

    if (aiType === 'codex') {
      if (/^codex\s+--yolo\b/i.test(trimmed)) continue;
      if (looksLikeCodexStartupLine(trimmed, squashed)) continue;
    }

    normalizedLines.push(trimmed);
  }

  const deduped = [];
  for (const line of normalizedLines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped.join('\n').trim();
}

function normalizeTranscriptLine(line) {
  return String(line || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s*\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)\s*/ig, ' ')
    .replace(/[┌┐└┘├┤─│╭╮╰╯═]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[●•]\s*/, '')
    .trim();
}

function looksLikeTranscriptActivityLine(line) {
  const trimmed = normalizeTranscriptLine(line);
  if (!trimmed) return true;
  if (looksLikeSourceCodeLine(trimmed)) return true;
  if (/^\d+\s+[+-]\s/.test(trimmed)) return true;
  if (/^\d+\s{2,}.*[{}();=]/.test(trimmed)) return true;
  if (/^(?:@@|[⋮│])/.test(trimmed)) return true;
  if (/^\d+\s+more\b/i.test(trimmed)) return true;
  if (/^\+\d+\s+lines\b/i.test(trimmed)) return true;
  return [
    /^(?:Ran|Read|Edited|Wrote|Opened|Searched|Commit|Committed|Pushed|Updated Plan)\b/i,
    /^(?:Bash|Read|Search|Update|Write|Edit)\(/i,
    /^(?:git|npm|pnpm|yarn|node|curl|ss|rg|cat|sed|cargo|python|pytest|vitest)\s+/i,
    /\b(?:tests?\s+passed|tests?\s+failed|passed|failed)\b/i,
  ].some((pattern) => pattern.test(trimmed));
}

function looksLikeRawTranscriptDump(content) {
  const trimmed = String(content || '').trim();
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (trimmed.length < 1200 && lines.length < 28) return false;
  const commandishLines = lines.filter((line) => (
    /\b(?:Ran|Read|Edited|Wrote|Commit|Pushed|Opened|Searched)\b/.test(line)
    || /\b(?:git|npm|node|curl|rg|sed)\s+/.test(line)
  )).length;
  return /\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)/i.test(trimmed)
    || commandishLines >= 6
    || lines.length >= 28;
}

function extractLatestReply(content) {
  const blocks = [];
  let currentBlock = [];

  for (const line of String(content || '').split('\n')) {
    if (!looksLikeTranscriptActivityLine(line)) {
      currentBlock.push(normalizeTranscriptLine(line));
      continue;
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
  }

  if (currentBlock.length > 0) blocks.push(currentBlock);
  const latestBlock = [...blocks].reverse().find((block) => block.join(' ').length >= 36);
  return latestBlock ? latestBlock.slice(-8).join('\n').trim() : '';
}

function buildVisibleTurns(turns, aiType) {
  const visibleTurns = [];
  let lastMeaningfulUserContent = '';
  let assistantFingerprintsForCurrentUser = new Set();

  const pushAssistantTurn = (turn, content) => {
    const fingerprint = visibleContentFingerprint(content);
    if (fingerprint.length >= 16 && assistantFingerprintsForCurrentUser.has(fingerprint)) return;
    if (fingerprint.length >= 16) assistantFingerprintsForCurrentUser.add(fingerprint);
    visibleTurns.push({ ...turn, content });
  };

  for (const turn of turns) {
    const content = String(turn?.content || '').trim();
    if (!content) continue;

    if (turn.role === 'user') {
      if (isLaunchCommand(content, aiType)) continue;
      if (isSlashCommandOnlyTurn(content)) continue;
      if (isShortFragmentTurn(content)) continue;
      if (looksLikeWrappedPromptEcho(content, lastMeaningfulUserContent)) continue;
      lastMeaningfulUserContent = content;
      assistantFingerprintsForCurrentUser = new Set();
      visibleTurns.push({ ...turn, content });
      continue;
    }

    if (turn.role === 'assistant') {
      const assistantContent = sanitizeAssistantContent(content, aiType);
      if (!assistantContent) continue;
      if (looksLikeWrappedPromptEcho(assistantContent, lastMeaningfulUserContent)) continue;

      if (looksLikeRawTranscriptDump(assistantContent)) {
        const latestReply = extractLatestReply(assistantContent);
        if (latestReply) pushAssistantTurn(turn, latestReply);
        continue;
      }

      pushAssistantTurn(turn, assistantContent);
    }
  }

  return visibleTurns;
}

/**
 * Renders terminal output as a chat message with basic markdown support.
 * Handles ``` code blocks and `inline code`.
 */
function ChatMessageContent({ content }) {
  const codeBlockParts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {codeBlockParts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '');
          return (
            <pre key={i} className="chat-code-block">
              <code>{inner}</code>
            </pre>
          );
        }

        const inlineParts = part.split(/(`[^`\n]+`)/g);
        return (
          <span key={i}>
            {inlineParts.map((p, j) => {
              if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
                return <code key={j} className="chat-inline-code">{p.slice(1, -1)}</code>;
              }
              return <span key={j}>{p}</span>;
            })}
          </span>
        );
      })}
    </>
  );
}

/** Animated three-dot typing indicator shown while Claude is responding. */
function TypingIndicator() {
  return (
    <div className="chat-typing-indicator">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  );
}

export function MobileChatView({
  turns,
  isStreaming = false,
  onSend,
  onInterrupt,
  onImageUpload,
  sessionId,
  isLoadingHistory = false,
  onViewportStateChange,
  aiType = null,
  runtimeInfo = null,
  connectionState = 'connecting',
  isSendReady = false,
  terminalPreview = '',
  terminalScreenSnapshot = '',
  customAiProviders = [],
}) {
  const { theme } = useTheme();
  const [inputValue, setInputValue] = useState('');
  const [isMicRecording, setIsMicRecording] = useState(false);
  const textareaRef = useRef(null);
  const assistantLabel = getAiDisplayLabel(aiType, customAiProviders) || 'Assistant';
  const visibleTurns = buildVisibleTurns(turns, aiType);
  const hasTerminalEvidence = Boolean(
    runtimeInfo?.label
    || String(terminalPreview || '').trim()
    || String(terminalScreenSnapshot || '').trim()
  );
  const statusLabel = connectionState === 'offline'
    ? 'offline'
    : connectionState === 'connecting'
      ? 'connecting'
      : isStreaming
        ? 'running'
        : !isSendReady
          ? 'starting'
          : 'ready';
  const emptyCopy = isLoadingHistory
    ? 'Loading session history...'
    : hasTerminalEvidence
      ? `Live terminal attached. ${assistantLabel} replies will appear here as clean chat turns.`
      : `Send a message to start this ${assistantLabel} session.`;
  const {
    containerRef,
    bottomRef,
    showScrollBtn,
    handleScroll,
    jumpToBottom,
    markShouldStickToBottom,
  } = useConversationScroll({
    deps: [visibleTurns, isStreaming],
    followBehavior: 'auto',
    onViewportStateChange,
  });

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    onSend(text);
    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    markShouldStickToBottom();
  }, [inputValue, onSend, markShouldStickToBottom]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleInputChange = useCallback((e) => {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  // Handle image paste into the textarea
  const handlePaste = useCallback(async (e) => {
    if (!sessionId || !e.clipboardData) return;
    const imageFile = await getImageFileFromDataTransfer(e.clipboardData);
    if (!imageFile) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const path = await uploadScreenshot(imageFile);
      if (path) {
        await apiFetch(`/api/terminal/${sessionId}/input`, {
          method: 'POST',
          body: { command: `${quoteTerminalPath(path)} ` }
        });
      }
    } catch (err) {
      console.error('Failed to paste image in chat:', err);
    }
  }, [sessionId]);


  return (
    <div className={`mobile-chat-view ${theme}`}>
      <div
        ref={containerRef}
        className="chat-messages"
        onScroll={handleScroll}
      >
        {visibleTurns.length === 0 && !isStreaming && (
          <div className={`chat-empty-state${aiType ? ' agent-session-card' : ''}`}>
            <div className="chat-empty-icon"><SparkleIcon size={22} /></div>
            <div className="chat-agent-card-body">
              <div className="chat-agent-card-top">
                <span className={`chat-provider-pill${aiType ? ` ai-${aiType}` : ''}`}>{assistantLabel}</span>
                <span className={`chat-agent-status status-${statusLabel}`}>{statusLabel}</span>
              </div>
              <div className="chat-agent-title">{assistantLabel} session</div>
              <p>{emptyCopy}</p>
              {(runtimeInfo?.label || hasTerminalEvidence) && (
                <div className="chat-agent-meta">
                  {runtimeInfo?.label && <span className="chat-agent-chip">{runtimeInfo.label}</span>}
                  {hasTerminalEvidence && <span className="chat-agent-chip">terminal attached</span>}
                </div>
              )}
            </div>
          </div>
        )}

        {visibleTurns.map((msg, index) => (
          <div key={`${msg.ts ?? index}-${msg.role}-${index}`} className={`chat-message-row ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="chat-avatar"><SparkleIcon size={13} /></div>
            )}
            <div className={`chat-bubble ${msg.role}`}>
              <div className="chat-bubble-content">
                <ChatMessageContent content={msg.content} />
              </div>
              <div className="chat-timestamp">
                {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}

        {isStreaming && (
          <div className="chat-message-row assistant">
            <div className="chat-avatar"><SparkleIcon size={13} /></div>
            <div className="chat-bubble assistant">
              <div className="chat-bubble-content">
                <TypingIndicator />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button
          type="button"
          className="mobile-scroll-bottom-btn chat-scroll-bottom-btn"
          onClick={() => {
            jumpToBottom();
          }}
          aria-label="Scroll to bottom"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      <div className="chat-input-bar">
        {!isMicRecording && (
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`Message ${assistantLabel}...`}
            rows={1}
          />
        )}

        {sessionId && (
          <TerminalMicButton
            sessionId={sessionId}
            provider="groq"
            inline
            onRecordingChange={setIsMicRecording}
          />
        )}

        {!isMicRecording && (
          <>
            {onImageUpload && (
              <button
                type="button"
                className="chat-icon-btn"
                onClick={onImageUpload}
                aria-label="Upload image"
                title="Upload image"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
            )}

            {onInterrupt && (
              <button
                type="button"
                className="chat-icon-btn chat-interrupt-btn"
                onClick={onInterrupt}
                aria-label="Interrupt (Ctrl+C)"
                title="Interrupt"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}

            <button
              type="button"
              className="chat-send-btn"
              onClick={handleSend}
              disabled={!inputValue.trim()}
              aria-label="Send message"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
