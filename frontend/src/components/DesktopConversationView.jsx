import { useEffect } from 'react';
import ToolCallBlock from './ToolCallBlock';
import { COMMON_LAUNCH_PREFIXES, getAiDisplayLabel, normalizeAiType } from '../utils/aiProviders';
import { useConversationScroll } from '../hooks/useConversationScroll';
import { parseInteractivePromptSnapshot, parseInteractivePromptEvent } from '../utils/interactivePrompt';

function compactText(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}

function getSnapshotLines(...sources) {
  return sources
    .filter((source) => typeof source === 'string' && source.trim())
    .flatMap((source) => source.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);
}

function mapKeyboardEventToTerminalInput(event) {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  if (metaKey) return null;

  if (ctrlKey && key && key.length === 1) {
    const lower = key.toLowerCase();
    const code = lower.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(code - 96);
    }
    return null;
  }

  switch (key) {
    case 'Enter':
      return '\r';
    case 'Tab':
      return shiftKey ? '\x1b[Z' : '\t';
    case 'Backspace':
      return '\x7f';
    case 'Delete':
      return '\x1b[3~';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      break;
  }

  if (!altKey && !ctrlKey && key && key.length === 1) {
    return key;
  }

  return null;
}

function isLaunchCommand(content, aiType) {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;

  const firstToken = normalized.split(/\s+/, 1)[0];
  if (COMMON_LAUNCH_PREFIXES.includes(firstToken)) {
    return true;
  }

  const normalizedAiType = normalizeAiType(aiType);
  if (normalizedAiType && (normalized === normalizedAiType || normalized.startsWith(`${normalizedAiType} `))) {
    return true;
  }

  return false;
}

function isSlashCommandOnlyTurn(content) {
  return /^\/[a-z0-9._:-]+$/i.test(content.trim());
}

function isShortFragmentTurn(content) {
  return /^[a-z]{1,2}$/i.test(content.trim());
}

function looksLikeBootstrapNoiseText(text) {
  if (!text) return true;
  const normalized = text.toLowerCase();

  const looksLikeWindowsBanner =
    normalized.includes('microsoft windows [version')
    || normalized.includes('microsoft corporation. all rights reserved');
  const looksLikeAgentBanner =
    normalized.includes('claude code v')
    || normalized.includes('codex v')
    || normalized.includes('gemini cli')
    || normalized.includes('sonnet 4.6');
  const looksLikePromptPath = /(?:[A-Za-z]:\\|~[\\/])[^\\\n]+.*>/.test(text);

  return looksLikeWindowsBanner || looksLikeAgentBanner || looksLikePromptPath;
}

function looksLikeDecoratedPathLine(line) {
  const withoutDecorators = line.replace(/^[^A-Za-z0-9~\\/.:_-]+/, '').trim();
  if (!withoutDecorators) return false;
  const pathLike = /^(~[\\/]|[A-Za-z]:\\)/.test(withoutDecorators);
  if (!pathLike) return false;
  return ((withoutDecorators.match(/[\\/]/g) ?? []).length >= 2) && !/[.!?]/.test(withoutDecorators);
}

function looksLikeInteractiveStatusLine(line, squashed) {
  if (!line.includes('>')) return false;
  const hasProgressVerb = /\b(thinking|computing|running|waiting|loading|initializing|caramelizing)\b/i.test(line);
  const hasTuiMarkers = /[·•*]/.test(line) || squashed.includes('presstochoose') || squashed.includes('selectanoption');
  return hasProgressVerb && hasTuiMarkers;
}

function looksLikeClaudeDashboardLine(line, squashed) {
  const separatorCount = (line.match(/\|/g) ?? []).length;
  const hasDashboardKeyword = [
    'recentactivity',
    'welcomeback',
    'whatsnew',
    '/resume',
    '/claude-api',
    'emptybashprompt',
    'numerickeypadsupport',
    'opus4.6withhigheffort',
    'claudemax',
  ].some((keyword) => squashed.includes(keyword));
  const looksLikeTuiChrome = separatorCount >= 1 || /[^\x00-\x7F]/.test(line);
  return hasDashboardKeyword && looksLikeTuiChrome;
}

function looksLikeCodexStartupLine(line, squashed) {
  const hasCodexStartupMarker = (
    squashed.includes('openaicodex(v')
    || squashed.includes('bootingmcpserver')
    || squashed.includes('improvedocumentationin@filename')
    || squashed.includes('new2xrationlimitsuntil')
    || ((squashed.includes('gpt-5.4high') || squashed.includes('gpt-5.4defalt')) && squashed.includes('100%left'))
    || (squashed.includes('model:') && squashed.includes('/modeltochange') && squashed.includes('100%left'))
  );
  return hasCodexStartupMarker && (/[^\x00-\x7F]/.test(line) || /\|/.test(line) || line.includes('\n') || squashed.includes('100%left'));
}

function looksLikeModelStatusFooter(line, squashed) {
  const hasStatusMarkers = line.includes('|') || /[🪟💰🔥🧠]/u.test(line);
  const hasModelOrUsage =
    squashed.includes('opus4.6')
    || squashed.includes('sonnet4.6')
    || squashed.includes('claudemax')
    || squashed.includes('gpt-5.4')
    || squashed.includes('session/')
    || squashed.includes('today/')
    || squashed.includes('/hr')
    || squashed.includes('%left')
    || /\$\d/.test(line);
  return hasStatusMarkers && hasModelOrUsage;
}

function stripModelStatusFooter(line) {
  return line
    .replace(/\s+(?:[|│]\s*)?(?:[🪟💰🔥🧠]\s*)?(?:Opus 4\.6|Sonnet 4\.6|gpt-5\.4)\b[\s\S]*$/i, '')
    .trim();
}

function looksLikeStatusFooterResidue(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/[|│]\s*[🪟💰🔥🧠]?\s*$/u.test(trimmed)) return true;
  if (/^codex\s+--yolo\b/i.test(trimmed)) return true;
  if (/\bmodel:\s*$/i.test(trimmed)) return true;
  return false;
}

function looksLikeCodexUpdatePrompt(content) {
  const squashed = compactText(content);
  return (
    squashed.includes('updateavailable!')
    && squashed.includes('github.com/openai/codex/releases/latest')
    && squashed.includes('@openai/codex')
    && squashed.includes('pressentertocontinue')
  );
}

function shouldHideMirrorScreenSnapshot(snapshot, aiType) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) return false;

  const squashed = compactText(snapshot);
  if (aiType === 'claude') {
    return looksLikeClaudeDashboardLine(snapshot, squashed)
      || squashed.includes('claudecodev')
      || squashed.includes('claudemax')
      || squashed.includes('found1settingsissue')
      || squashed.includes('claude.aiconnectorneedsauth');
  }

  if (aiType === 'codex') {
    return looksLikeCodexStartupLine(snapshot, squashed)
      || squashed.includes('tip:new2xrationlimitsuntil');
  }

  return false;
}

function normalizeClaudeAssistantLine(line) {
  let normalized = line
    .replace(/^MCP server failed \(\/mcp\)\. Open Terminal Panel for details\.\s*/i, '')
    .replace(/^[✶✽✢·*]+\s+\w+…\s*[>❯]\s*/i, '')
    .replace(/[─-]{10,}\s*[>❯]\s*/g, ' ')
    .replace(/\s+Opus 4\.6\s+\|.*$/i, '')
    .replace(/^[●•]\s*/, '')
    .trim();

  if (!normalized) return '';
  const letters = (normalized.match(/[A-Za-z ]/g) ?? []).length;
  if (letters / normalized.length < 0.55) return '';
  return normalized;
}

function sanitizeAssistantTurnContent(content, aiType) {
  if (typeof content !== 'string') return '';
  if (aiType === 'codex' && looksLikeCodexUpdatePrompt(content)) return '';

  const normalizedLines = [];
  const lines = content.split('\n');
  for (const rawLine of lines) {
    let trimmed = rawLine.trim();
    if (!trimmed) continue;

    trimmed = stripModelStatusFooter(trimmed);
    if (!trimmed) continue;

    const squashed = compactText(trimmed);
    if (looksLikeInteractiveStatusLine(trimmed, squashed)) continue;
    if (looksLikeModelStatusFooter(trimmed, squashed)) continue;
    if (looksLikeStatusFooterResidue(trimmed)) continue;
    if (/^\s*[>❯]\s*$/.test(trimmed)) continue;
    if (squashed.includes('microsoftwindows[version')) continue;
    if (squashed.includes('microsoftcorporation.allrightsreserved')) continue;
    if (squashed.startsWith('claude--dangerously-skip-permissions')) continue;
    if (looksLikeDecoratedPathLine(trimmed)) continue;

    if (aiType === 'claude') {
      if (squashed.includes('claudecodev')) continue;
      if (squashed.includes('sonnet4.6') && squashed.includes('claudemax')) continue;
      if (squashed.includes('bypasspermissionson')) continue;
      if (squashed.includes('shift+tabtocycle')) continue;
      if (squashed.includes('found1settingsissue') && squashed.includes('/doctor')) continue;
      if (trimmed.includes('>') && /[·•*]/.test(trimmed) && /\b(thinking|computing|running|waiting|caramelizing)\b/i.test(trimmed)) continue;

      if (looksLikeClaudeDashboardLine(trimmed, squashed)) continue;

      if (squashed.includes('mcpserverfailed')) {
        const normalizedClaudeLine = normalizeClaudeAssistantLine(trimmed);
        if (normalizedClaudeLine && !compactText(normalizedClaudeLine).includes('mcpserverfailed')) {
          normalizedLines.push(normalizedClaudeLine);
        } else if (!normalizedLines.includes('MCP server failed (/mcp). Open Terminal Panel for details.')) {
          normalizedLines.push('MCP server failed (/mcp). Open Terminal Panel for details.');
        }
        continue;
      }

      if (looksLikeDecoratedPathLine(trimmed)) continue;
    }

    if (aiType === 'codex' && looksLikeCodexStartupLine(trimmed, squashed)) continue;

    normalizedLines.push(trimmed);
  }

  const dedupedLines = [];
  for (const line of normalizedLines) {
    if (dedupedLines[dedupedLines.length - 1] !== line) {
      dedupedLines.push(line);
    }
  }
  return dedupedLines.join('\n').trim();
}

function buildVisibleTurns(turns, aiType) {
  const visibleTurns = [];
  let hasMeaningfulUserTurn = false;

  for (const turn of turns) {
    if (!turn || typeof turn.content !== 'string') continue;

    if (turn.role === 'user') {
      const userContent = turn.content.trim();
      if (!userContent) continue;
      if (isLaunchCommand(userContent, aiType)) continue;
      if (isSlashCommandOnlyTurn(userContent)) continue;
      if (isShortFragmentTurn(userContent)) continue;
      hasMeaningfulUserTurn = true;
      visibleTurns.push({ ...turn, content: userContent });
      continue;
    }

    if (turn.role === 'assistant') {
      const assistantContent = sanitizeAssistantTurnContent(turn.content, aiType);
      if (!assistantContent) continue;
      if (!hasMeaningfulUserTurn && looksLikeBootstrapNoiseText(assistantContent)) continue;
      visibleTurns.push({ ...turn, content: assistantContent });
      continue;
    }

    visibleTurns.push(turn);
  }

  return visibleTurns;
}

function extractWorkingDirectory(...sources) {
  for (const source of sources) {
    if (typeof source !== 'string' || !source.trim()) continue;

    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const directoryMatch = line.match(/^(?:directory|cwd)\s*:\s*(.+)$/i);
      const promptPathMatch = line.match(/^([A-Za-z]:\\.+|~[\\/].+)>$/);
      const barePathMatch = line.match(/^([A-Za-z]:\\.+|~[\\/].+)$/);

      const candidate = directoryMatch?.[1]?.trim()
        || promptPathMatch?.[1]?.trim()
        || barePathMatch?.[1]?.trim()
        || '';

      if (!candidate) continue;
      if ((candidate.match(/[\\/]/g) ?? []).length < 2) continue;
      return candidate;
    }
  }

  return '';
}

function extractLiveSessionTitle(lines, aiType) {
  if (!Array.isArray(lines) || lines.length === 0) return '';

  if (aiType === 'claude') {
    return lines.find((line) => /\bClaude Code v[^\s]+/i.test(line)) || '';
  }
  if (aiType === 'codex') {
    return lines.find((line) => /\bOpenAI Codex\b/i.test(line)) || '';
  }
  if (aiType === 'gemini') {
    return lines.find((line) => /\bGemini CLI\b/i.test(line)) || '';
  }

  return lines.find((line) => /\b(Claude Code|OpenAI Codex|Gemini CLI)\b/i.test(line)) || '';
}

function extractLiveRuntimeLabel(lines, aiType) {
  if (!Array.isArray(lines) || lines.length === 0) return '';

  const runtimePatterns = aiType === 'claude'
    ? [/\b(Opus 4\.6|Sonnet 4\.6|Claude Max)\b/i]
    : aiType === 'codex'
      ? [/\bgpt-5\.4\b/i, /\b\d+%\s+left\b/i]
      : aiType === 'gemini'
        ? [/\bGemini\b/i, /\b(context|ctx|token)\b/i]
        : [/\b(Opus 4\.6|Sonnet 4\.6|Claude Max|gpt-5\.4|Gemini)\b/i];

  return lines.find((line) => runtimePatterns.every((pattern) => pattern.test(line))) || '';
}

function extractLiveSessionIssues(lines, interactivePrompt) {
  const issues = [];
  const registerIssue = (value) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized && !issues.includes(normalized)) {
      issues.push(normalized);
    }
  };

  const combined = [
    ...lines,
    typeof interactivePrompt?.prompt === 'string' ? interactivePrompt.prompt : '',
  ];

  combined.forEach((line) => {
    const normalized = String(line || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;

    if (/mcp server failed/i.test(normalized)) {
      registerIssue('MCP server failed /mcp');
      return;
    }

    if (/connector needs auth/i.test(normalized)) {
      registerIssue('Claude connector needs auth /mcp');
    }
  });

  return issues;
}

function normalizeInteractivePromptText(prompt) {
  if (typeof prompt !== 'string') return '';

  return prompt
    .replace(/\s+/g, ' ')
    .replace(/^>\s*/, '')
    .replace(/\s+\d+\s*(?:mcp server failed|claude\.ai connector needs auth)[\s\S]*$/i, '')
    .replace(/\s+[|·•]\s*\/mcp[\s\S]*$/i, '')
    .trim();
}

function getStatusTone(statusLabel) {
  switch (statusLabel) {
    case 'input':
      return 'input-required';
    case 'running':
      return 'responding';
    case 'connecting':
      return 'connecting';
    case 'starting':
      return 'preparing';
    case 'offline':
      return 'offline';
    case 'live':
      return 'live';
    case 'ready':
    default:
      return 'ready';
  }
}

function getStatusLabel({
  interactivePrompt,
  isStreaming,
  isOffline,
  connectionState,
  isSendReady,
  showTerminalMirror,
}) {
  if (interactivePrompt) return 'input';
  if (isOffline) return 'offline';
  if (connectionState === 'connecting') return 'connecting';
  if (isStreaming) return 'running';
  if (showTerminalMirror) return 'live';
  if (!isSendReady) return 'starting';
  return 'ready';
}

function TypingIndicator() {
  return (
    <span className="dcv-cursor-blink" aria-label="Assistant is responding">▍</span>
  );
}

export function DesktopConversationView({
  turns,
  isStreaming = false,
  onSend,
  onSendRaw,
  onInterrupt,
  onImageUpload,
  sessionId,
  isLoadingHistory = false,
  aiType = null,
  connectionState = 'connecting',
  isSendReady = false,
  terminalPreview = '',
  terminalScreenSnapshot = '',
  launchCommand = '',
  launchQueued = false,
  onLaunchAgent,
  onOpenTerminal,
  conversationNotice = '',
  showTerminalMirror = false,
  interactivePromptEvent = null,
  isTerminalDockVisible = false,
  mode = 'terminal',
  structuredMessages = [],
  structuredToolCalls = [],
  pendingApproval = null,
  onApprove = null,
  allowPromptKeyboardCapture = false,
}) {
  const assistantLabel = getAiDisplayLabel(aiType) || 'Assistant';
  const isStructured = mode === 'structured';
  const visibleTurns = isStructured ? [] : buildVisibleTurns(turns, aiType);
  const hasBackgroundOutput = typeof terminalPreview === 'string' && terminalPreview.trim().length > 0;
  const hasLiveScreenSnapshot = typeof terminalScreenSnapshot === 'string' && terminalScreenSnapshot.trim().length > 0;
  const snapshotLines = getSnapshotLines(terminalScreenSnapshot, terminalPreview);
  const interactivePromptFromEvent = parseInteractivePromptEvent(interactivePromptEvent);
  const interactivePrompt = interactivePromptFromEvent
    || (hasLiveScreenSnapshot
      ? parseInteractivePromptSnapshot(terminalScreenSnapshot)
      : null);
  const shouldCaptureRawKeyboard = allowPromptKeyboardCapture && showTerminalMirror && Boolean(interactivePrompt);
  const showInteractivePromptBlock = Boolean(interactivePrompt && interactivePrompt.actions?.length > 0);
  const shouldShowMirrorScreen = false;
  const displayTurns = isStructured ? [] : visibleTurns;
  const isConnected = connectionState === 'online';
  const isOffline = connectionState === 'offline';
  const statusLabel = getStatusLabel({
    interactivePrompt,
    isStreaming,
    isOffline,
    connectionState,
    isSendReady,
    showTerminalMirror,
  });
  const promptFallbackNotice =
    interactivePrompt && !showInteractivePromptBlock
      ? `Interactive terminal prompt active: ${interactivePrompt.prompt}`
      : '';
  const normalizedInteractivePrompt = normalizeInteractivePromptText(interactivePrompt?.prompt);
  const workingDirectory = extractWorkingDirectory(terminalScreenSnapshot, terminalPreview);
  const liveSessionTitle = extractLiveSessionTitle(snapshotLines, aiType);
  const liveRuntimeLabel = extractLiveRuntimeLabel(snapshotLines, aiType);
  const liveSessionIssues = extractLiveSessionIssues(snapshotLines, interactivePrompt);
  const hasLiveSessionEvidence = Boolean(
    showTerminalMirror
    || hasLiveScreenSnapshot
    || hasBackgroundOutput
    || liveSessionTitle
    || liveRuntimeLabel
    || showInteractivePromptBlock
    || liveSessionIssues.length > 0
  );
  const hasStructuredActivity = isStructured && (
    structuredMessages.length > 0
    || structuredToolCalls.length > 0
    || Boolean(pendingApproval)
  );
  const hasVisibleTurns = displayTurns.length > 0 || hasStructuredActivity;
  const showStartupCard = !hasVisibleTurns && !isLoadingHistory;
  const showTerminalStartupCard = !isStructured && displayTurns.length === 0 && !isLoadingHistory;
  const showInlineInteractivePrompt = showInteractivePromptBlock && !showTerminalStartupCard;
  const shouldRenderHeader = !showTerminalStartupCard;
  const showPromptCopyInStartupPanel = !(showTerminalStartupCard && isTerminalDockVisible);
  const showTerminalPreviewInStartupCard = Boolean(terminalPreview) && !(showTerminalStartupCard && isTerminalDockVisible);
  const showLaunchButton = Boolean(launchCommand && (!showTerminalStartupCard || !hasLiveSessionEvidence));
  const showOpenTerminalButton = Boolean(!isStructured && onOpenTerminal && !isTerminalDockVisible);
  const hasStartupActions = showLaunchButton || showOpenTerminalButton;
  const startupMessage = isStructured
    ? (isOffline
      ? 'Structured session is offline. Refresh the session stream and try again.'
      : connectionState === 'connecting'
        ? 'Connecting to the structured session stream...'
        : isStreaming
          ? `${assistantLabel} is responding. Waiting for the first visible message...`
          : `Send a message to start this ${assistantLabel} session.`)
    : (isOffline
      ? 'Terminal is offline. Reconnect or open the terminal panel to inspect the session.'
      : connectionState === 'connecting'
        ? 'Connecting to terminal transport. You can still queue a launch command now.'
        : showInteractivePromptBlock
          ? `${assistantLabel} is waiting for terminal input before the first transcript turn.`
        : liveSessionTitle || liveRuntimeLabel
          ? `Live terminal attached. The first captured turn will appear here once ${assistantLabel} responds in full.`
        : hasBackgroundOutput
          ? `${assistantLabel} launched in background. Waiting for the first conversation turn...`
          : !isSendReady
          ? 'Transport is online and preparing input channel...'
        : isStreaming
          ? `${assistantLabel} is running. Waiting for the first response turn...`
          : `No ${assistantLabel} response yet. Start the CLI agent to begin this thread.`);
  const startupCardSubtitle = showInteractivePromptBlock
    ? (isTerminalDockVisible
      ? `${assistantLabel} is paused on a terminal prompt. The live terminal is docked below so the exact screen state stays visible while you keep the conversation context above.`
      : `${assistantLabel} is paused on a terminal prompt. Choose an action here or open the raw terminal for full control.`)
    : liveSessionTitle || liveRuntimeLabel
      ? `Live terminal attached. Codex UI will show the transcript once ${assistantLabel} posts a full response turn.`
      : hasBackgroundOutput
        ? `${assistantLabel} launched in background. The transcript will appear here after the first full response turn.`
        : startupMessage;
  const headerTitle = liveSessionTitle || `${assistantLabel} session`;
  const headerSubtitle = isStructured
    ? 'Structured conversation view'
    : showInteractivePromptBlock
      ? 'Live terminal prompt detected. Codex UI keeps the session context visible while the terminal waits for input.'
      : liveRuntimeLabel
        ? 'Live terminal summary'
        : displayTurns.length > 0
          ? 'Conversation transcript'
          : startupMessage;
  const statusTone = getStatusTone(statusLabel);
  const {
    containerRef,
    bottomRef,
    autoScrollRef,
    showScrollBtn,
    handleScroll,
    jumpToBottom,
    markShouldStickToBottom,
  } = useConversationScroll({
    deps: [turns, structuredMessages, structuredToolCalls, pendingApproval, isStreaming],
    followBehavior: 'auto',
  });

  useEffect(() => {
    if (!shouldCaptureRawKeyboard) return undefined;

    const handleGlobalKeyDown = (event) => {
      const target = event.target;
      const isInput = target instanceof HTMLInputElement;
      const isTextarea = target instanceof HTMLTextAreaElement;
      const isEditable = isInput || isTextarea || Boolean(target?.isContentEditable);
      if (isEditable) return;

      const payload = mapKeyboardEventToTerminalInput(event);
      if (!payload) return;

      event.preventDefault();
      event.stopPropagation();
      onSendRaw?.(payload);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [onSendRaw, shouldCaptureRawKeyboard]);

  return (
    <div className="desktop-conversation-view mode-conversation">
      {shouldRenderHeader && (
        <div className="desktop-conversation-header">
          <div className="desktop-conversation-header-main">
            <span className={`desktop-conversation-provider${aiType ? ` ai-${aiType}` : ''}`}>
              {assistantLabel}
            </span>
            <div className="desktop-conversation-heading">
              <span className="desktop-conversation-title">{headerTitle}</span>
              <span className="desktop-conversation-subtitle">{headerSubtitle}</span>
            </div>
          </div>
          <div className="desktop-conversation-header-meta">
            {workingDirectory && (
              <div className="desktop-conversation-path-block">
                <span className="desktop-conversation-path-label">Workspace</span>
                <code className="desktop-conversation-path-value">{workingDirectory}</code>
              </div>
            )}
            <div className="desktop-conversation-chip-row">
              <span className={`desktop-conversation-chip status-${statusTone}`}>
                {statusLabel}
              </span>
              {liveRuntimeLabel && (
                <span className="desktop-conversation-chip">{liveRuntimeLabel}</span>
              )}
              {showInteractivePromptBlock && (
                <span className="desktop-conversation-chip mode-prompt">Prompt active</span>
              )}
              {liveSessionIssues.map((issue) => (
                <span key={issue} className="desktop-conversation-chip mode-prompt">
                  {issue}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div ref={containerRef} className="desktop-thread" onScroll={handleScroll}>
        <div className={`desktop-thread-inner${showTerminalStartupCard ? ' live-session-layout' : ''}`}>
          {conversationNotice && (
            <div className="desktop-agent-inline-notice" role="status" aria-live="polite">
              {conversationNotice}
            </div>
          )}

          {promptFallbackNotice && (
            <div className="desktop-agent-inline-notice" role="status" aria-live="polite">
              {promptFallbackNotice}
            </div>
          )}

          {showInlineInteractivePrompt && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className="structured-approval-prompt">
                  <p>{normalizedInteractivePrompt || interactivePrompt.prompt}</p>
                  <div className="desktop-interactive-prompt-actions">
                    {interactivePrompt.actions.map((action) => (
                      <button
                        key={`${action.label}:${action.payload}`}
                        type="button"
                        className={`desktop-interactive-action ${action.kind === 'primary' ? 'primary' : 'secondary'}`}
                        onClick={() => onSendRaw?.(action.payload)}
                        disabled={!onSendRaw}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {!hasVisibleTurns && isLoadingHistory && (
            <div className="desktop-conversation-empty">Loading conversation history...</div>
          )}

          {showStartupCard && (
            <div className={`desktop-agent-status-card${showTerminalStartupCard ? ' live-session-card' : ''}`} role="status" aria-live="polite">
              {showTerminalStartupCard && (
                <>
                  <div className="desktop-agent-session-overview">
                    <div className="desktop-conversation-header-main">
                      <span className={`desktop-conversation-provider${aiType ? ` ai-${aiType}` : ''}`}>
                        {assistantLabel}
                      </span>
                      <div className="desktop-conversation-heading">
                        <span className="desktop-conversation-title">{headerTitle}</span>
                        <span className="desktop-conversation-subtitle">{startupCardSubtitle}</span>
                      </div>
                    </div>
                    <div className="desktop-conversation-header-meta">
                      {workingDirectory && (
                        <div className="desktop-conversation-path-block">
                          <span className="desktop-conversation-path-label">Workspace</span>
                          <code className="desktop-conversation-path-value">{workingDirectory}</code>
                        </div>
                      )}
                      <div className="desktop-conversation-chip-row">
                        <span className={`desktop-conversation-chip status-${statusTone}`}>
                          {statusLabel}
                        </span>
                        {liveRuntimeLabel && (
                          <span className="desktop-conversation-chip">{liveRuntimeLabel}</span>
                        )}
                        {showInteractivePromptBlock && (
                          <span className="desktop-conversation-chip mode-prompt">Prompt active</span>
                        )}
                        {liveSessionIssues.map((issue) => (
                          <span key={`card-${issue}`} className="desktop-conversation-chip mode-prompt">
                            {issue}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {showInteractivePromptBlock && (
                    <div className="desktop-agent-prompt-panel">
                      <span className="desktop-cli-focus-section-label">
                        {isTerminalDockVisible ? 'Quick actions' : 'Awaiting input'}
                      </span>
                      {showPromptCopyInStartupPanel ? (
                        <p className="desktop-agent-prompt-copy">
                          {normalizedInteractivePrompt || interactivePrompt.prompt}
                        </p>
                      ) : (
                        <p className="desktop-agent-prompt-hint">
                          Live terminal prompt is docked below. Use the dock for the exact state, or use a quick action here.
                        </p>
                      )}
                      <div className="desktop-interactive-prompt-actions">
                        {interactivePrompt.actions.map((action) => (
                          <button
                            key={`${action.label}:${action.payload}`}
                            type="button"
                            className={`desktop-interactive-action ${action.kind === 'primary' ? 'primary' : 'secondary'}`}
                            onClick={() => onSendRaw?.(action.payload)}
                            disabled={!onSendRaw}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {!showTerminalStartupCard && (
                <pre className="dcv-startup-text">
                <span className="dcv-startup-msg">{startupMessage}</span>
                <span className="dcv-cursor-blink">▍</span>
                </pre>
              )}

              {showLaunchButton && (
                <div className="dcv-startup-cmd">
                  <span className="dcv-prompt-char">$</span>
                  <code>{launchCommand}</code>
                  {launchQueued && <span className="dcv-queued-tag">queued</span>}
                </div>
              )}

              {hasStartupActions && (
                <div className="desktop-agent-actions-row">
                  {showLaunchButton && (
                    <button
                      type="button"
                      className="desktop-agent-action primary"
                      onClick={onLaunchAgent}
                      disabled={!onLaunchAgent || isOffline || isStreaming}
                    >
                      Launch {assistantLabel}
                    </button>
                  )}
                  {showOpenTerminalButton && (
                    <button
                      type="button"
                      className="desktop-agent-action"
                      onClick={onOpenTerminal}
                      disabled={!onOpenTerminal}
                    >
                      Open Raw Terminal
                    </button>
                  )}
                </div>
              )}

              {showTerminalPreviewInStartupCard && (
                <pre className="desktop-agent-output-pre">
                  {terminalPreview}
                </pre>
              )}
            </div>
          )}

          {displayTurns.map((turn, index) => (
            <ToolCallBlock
              key={`${turn.ts ?? index}-${turn.role}-${index}`}
              item={{ type: turn.role, content: turn.content }}
            />
          ))}

          {isStructured && structuredMessages.map((msg, index) => {
            if (msg.role === 'user') {
              return (
                <ToolCallBlock
                  key={`s-${msg.ts ?? index}-user-${index}`}
                  item={{ type: 'user', content: msg.content }}
                />
              );
            }
            if (msg.role === 'assistant') {
              return (
                <ToolCallBlock
                  key={`s-${msg.ts ?? index}-assistant-${index}`}
                  item={{ type: 'assistant', content: msg.content }}
                />
              );
            }
            if (msg.role === 'tool') {
              return (
                <ToolCallBlock
                  key={`s-${msg.ts ?? index}-tool-${index}`}
                  item={{
                    type: 'tool_use',
                    tool: msg.toolName,
                    toolInput: msg.toolInput,
                    result: {
                      toolResult: msg.result || '',
                      isError: Boolean(msg.isError)
                    }
                  }}
                />
              );
            }
            if (msg.role === 'error') {
              return (
                <div key={`s-${msg.ts ?? index}-error-${index}`} className="cc-message cc-error">
                  <div className="cc-error-bubble">{msg.content}</div>
                </div>
              );
            }
            return null;
          })}

          {isStructured && structuredToolCalls.length > 0 && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                {structuredToolCalls.map((tc, i) => (
                  <div key={`tc-${i}`} className="structured-tool-running">
                    Running <strong>{tc.toolName}</strong>...
                    {tc.result && <pre className="structured-tool-partial">{tc.result}</pre>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isStructured && pendingApproval && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className="structured-approval-prompt">
                  <p>{pendingApproval.description || pendingApproval.prompt || `Approve ${pendingApproval.toolName}?`}</p>
                  {pendingApproval.toolInput && (
                    <pre className="structured-approval-input">{JSON.stringify(pendingApproval.toolInput, null, 2)}</pre>
                  )}
                  <div className="desktop-interactive-prompt-actions">
                    <button
                      type="button"
                      className="desktop-interactive-action primary"
                      onClick={() => onApprove?.(true)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="desktop-interactive-action secondary"
                      onClick={() => onApprove?.(false)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {isStreaming && !isStructured && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <TypingIndicator />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button
          type="button"
          className="desktop-conversation-scroll-btn"
          onClick={() => {
            jumpToBottom();
          }}
          aria-label="Scroll to latest message"
          title="Scroll to latest message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {/* Composer removed — the V4 status bar composer is the single input */}
    </div>
  );
}
