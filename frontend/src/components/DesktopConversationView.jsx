import { useRef, useEffect, useState, useCallback } from 'react';
import ToolCallBlock from './ToolCallBlock';
import { apiFetch, uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { COMMON_LAUNCH_PREFIXES, getAiDisplayLabel, normalizeAiType } from '../utils/aiProviders';

function compactText(value) {
  return value.toLowerCase().replace(/\s+/g, '');
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

function parseInteractivePromptSnapshot(snapshotText) {
  if (typeof snapshotText !== 'string') return null;
  const text = snapshotText.trim();
  if (!text) return null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const lowerText = text.toLowerCase();
  const numberedOptions = lines
    .map((line, index) => {
      const match = line.match(/^([›>]\s*)?(\d+)\.\s+(.+)$/);
      if (!match) return null;
      return {
        index,
        isSelected: Boolean(match[1]),
        number: match[2],
        label: `${match[2]}. ${match[3].trim()}`
      };
    })
    .filter(Boolean);
  const promptLine = [...lines].reverse().find((line) => (
    /\[[yYnN]\/[yYnN]\]/.test(line)
    || /(?:continue anyway|trust this folder|select an option|confirm|cancel)/i.test(line)
    || /(?:enter|esc|shift\+tab|tab to cycle)/i.test(line)
  )) || lines[lines.length - 1];

  const actions = [];
  if (numberedOptions.length > 0) {
    const selectedIndex = numberedOptions.findIndex((option) => option.isSelected);
    const baseIndex = selectedIndex >= 0 ? selectedIndex : 0;
    for (let index = 0; index < numberedOptions.length; index += 1) {
      const option = numberedOptions[index];
      const delta = index - baseIndex;
      const navigation = delta > 0
        ? '\x1b[B'.repeat(delta)
        : '\x1b[A'.repeat(Math.abs(delta));
      actions.push({
        label: option.label,
        payload: `${navigation}\r`,
        kind: option.isSelected || (selectedIndex === -1 && index === 0) ? 'primary' : 'secondary'
      });
    }
  }

  if (/\[[yYnN]\/[yYnN]\]/.test(promptLine) || /continue anyway|trust this folder/i.test(promptLine)) {
    actions.push(
      { label: 'Yes', payload: 'y\r', kind: 'primary' },
      { label: 'No', payload: 'n\r', kind: 'secondary' }
    );
  }

  if (/enter to (confirm|continue)|\[[yYnN]\/[yYnN]\]|continue anyway|confirm/i.test(promptLine) || /enter to (confirm|continue)/i.test(lowerText)) {
    actions.push({ label: 'Enter', payload: '\r', kind: 'secondary' });
  }

  if (/esc(?:ape)? to cancel|cancel/i.test(promptLine) || /esc(?:ape)? to cancel/i.test(lowerText)) {
    actions.push({ label: 'Esc', payload: '\x1b', kind: 'secondary' });
  }

  if (/shift\+tab to cycle|tab to cycle/i.test(promptLine) || /shift\+tab to cycle|tab to cycle/i.test(lowerText)) {
    actions.push(
      { label: 'Tab', payload: '\t', kind: 'secondary' },
      { label: 'Shift+Tab', payload: '\x1b[Z', kind: 'secondary' }
    );
  }

  if (actions.length === 0) {
    return null;
  }

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = `${action.label}:${action.payload}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }

  return {
    prompt: promptLine,
    actions: deduped
  };
}

function parseInteractivePromptEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'prompt_required') return null;
  if (typeof event.prompt !== 'string' || event.prompt.trim().length === 0) return null;

  const actionMap = {
    yes: { label: 'Yes', payload: 'y\r', kind: 'primary' },
    no: { label: 'No', payload: 'n\r', kind: 'secondary' },
    enter: { label: 'Enter', payload: '\r', kind: 'secondary' },
    escape: { label: 'Esc', payload: '\x1b', kind: 'secondary' },
    tab: { label: 'Tab', payload: '\t', kind: 'secondary' },
    shift_tab: { label: 'Shift+Tab', payload: '\x1b[Z', kind: 'secondary' }
  };

  const requestedActions = Array.isArray(event.actions)
    ? event.actions.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
  const mapped = requestedActions.map((name) => actionMap[name]).filter(Boolean);
  const actions = mapped.length > 0 ? mapped : [{ label: 'Enter', payload: '\r', kind: 'secondary' }];

  return {
    prompt: event.prompt.trim(),
    actions
  };
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
  mode = 'terminal',
  structuredMessages = [],
  structuredToolCalls = [],
  pendingApproval = null,
  onApprove = null,
}) {
  const [inputValue, setInputValue] = useState('');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const autoScrollRef = useRef(true);
  const assistantLabel = getAiDisplayLabel(aiType) || 'Assistant';
  const isStructured = mode === 'structured';
  const visibleTurns = isStructured ? [] : buildVisibleTurns(turns, aiType);
  const hasBackgroundOutput = typeof terminalPreview === 'string' && terminalPreview.trim().length > 0;
  const hasLiveScreenSnapshot = typeof terminalScreenSnapshot === 'string' && terminalScreenSnapshot.trim().length > 0;
  const interactivePromptFromEvent = parseInteractivePromptEvent(interactivePromptEvent);
  const interactivePrompt = interactivePromptFromEvent
    || (hasLiveScreenSnapshot
      ? parseInteractivePromptSnapshot(terminalScreenSnapshot)
      : null);
  const shouldCaptureRawKeyboard = showTerminalMirror && Boolean(interactivePrompt);
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
  const workingDirectory = extractWorkingDirectory(terminalScreenSnapshot, terminalPreview);
  const hasVisibleTurns =
    displayTurns.length > 0
    || Boolean(interactivePrompt)
    || (isStructured && (
      structuredMessages.length > 0
      || structuredToolCalls.length > 0
      || Boolean(pendingApproval)
    ));
  const showStartupCard = !hasVisibleTurns && !isLoadingHistory;
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
        : hasBackgroundOutput
          ? `${assistantLabel} launched in background. Waiting for the first conversation turn...`
          : !isSendReady
          ? 'Transport is online and preparing input channel...'
        : isStreaming
          ? `${assistantLabel} is running. Waiting for the first response turn...`
          : `No ${assistantLabel} response yet. Start the CLI agent to begin this thread.`);

  const scrollToBottom = useCallback(() => {
    const element = bottomRef.current;
    if (!element || typeof element.scrollIntoView !== 'function') return;
    element.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    scrollToBottom();
  }, [turns, structuredMessages, structuredToolCalls, pendingApproval, isStreaming, scrollToBottom]);

  useEffect(() => {
    if (!shouldCaptureRawKeyboard) return undefined;

    const handleGlobalKeyDown = (event) => {
      const target = event.target;
      const isInput = target instanceof HTMLInputElement;
      const isTextarea = target instanceof HTMLTextAreaElement;
      const isEditable = isInput || isTextarea || Boolean(target?.isContentEditable);
      if (isEditable) {
        const isComposer = target === textareaRef.current;
        if (!isComposer) return;
        const hasText = Boolean(textareaRef.current?.value?.length);
        if (hasText && event.key !== 'Enter') return;
      }

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

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const handleInputChange = useCallback((event) => {
    setInputValue(event.target.value);
    const element = event.target;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    onSend?.(text);
    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    autoScrollRef.current = true;
  }, [inputValue, onSend]);

  const handleKeyDown = useCallback((event) => {
    if (shouldCaptureRawKeyboard) {
      const payload = mapKeyboardEventToTerminalInput(event);
      if (payload) {
        event.preventDefault();
        event.stopPropagation();
        onSendRaw?.(payload);
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    handleSend();
  }, [handleSend, onSendRaw, shouldCaptureRawKeyboard]);

  const handlePaste = useCallback(async (event) => {
    if (!sessionId || !event.clipboardData) return;
    const imageFile = await getImageFileFromDataTransfer(event.clipboardData);
    if (!imageFile) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const path = await uploadScreenshot(imageFile);
      if (path) {
        await apiFetch(`/api/terminal/${sessionId}/input`, {
          method: 'POST',
          body: { command: `${path} ` }
        });
      }
    } catch (error) {
      console.error('Failed to paste image in conversation view:', error);
    }
  }, [sessionId]);

  return (
    <div className="desktop-conversation-view mode-conversation">
      <div className="desktop-conversation-header">
        <div className="desktop-conversation-header-main">
          <span className={`dcv-status-dot status-${statusLabel}`} title={statusLabel} />
          <span className={`desktop-conversation-provider${aiType ? ` ai-${aiType}` : ''}`}>
            {assistantLabel}
          </span>
          {workingDirectory && (
            <>
              <span className="dcv-sep" aria-hidden="true">/</span>
              <code className="desktop-conversation-path-value">{workingDirectory}</code>
            </>
          )}
        </div>
        <span className={`desktop-conversation-status status-${statusLabel}`}>
          {statusLabel}
        </span>
      </div>

      <div ref={containerRef} className="desktop-thread" onScroll={handleScroll}>
        <div className="desktop-thread-inner">
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

          {showInteractivePromptBlock && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className="structured-approval-prompt">
                  <p>{interactivePrompt.prompt}</p>
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
            <div className="desktop-agent-status-card" role="status" aria-live="polite">
              <pre className="dcv-startup-text">
                <span className="dcv-startup-msg">{startupMessage}</span>
                <span className="dcv-cursor-blink">▍</span>
              </pre>

              {launchCommand && (
                <div className="dcv-startup-cmd">
                  <span className="dcv-prompt-char">$</span>
                  <code>{launchCommand}</code>
                  {launchQueued && <span className="dcv-queued-tag">queued</span>}
                </div>
              )}

              <div className="desktop-agent-actions-row">
                {launchCommand && (
                  <button
                    type="button"
                    className="desktop-agent-action primary"
                    onClick={onLaunchAgent}
                    disabled={!onLaunchAgent || isOffline || isStreaming}
                  >
                    Launch {assistantLabel}
                  </button>
                )}
                {!isStructured && (
                  <button
                    type="button"
                    className="desktop-agent-action"
                    onClick={onOpenTerminal}
                    disabled={!onOpenTerminal}
                  >
                    Open Terminal
                  </button>
                )}
              </div>

              {terminalPreview && (
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
            autoScrollRef.current = true;
            setShowScrollBtn(false);
            scrollToBottom();
          }}
          aria-label="Scroll to latest message"
          title="Scroll to latest message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      <div className="desktop-conversation-composer">
        <span className="dcv-prompt-char" aria-hidden="true">›</span>
        <textarea
          ref={textareaRef}
          className="desktop-conversation-input"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={`Message ${assistantLabel}...`}
          rows={1}
        />

        <div className="desktop-conversation-actions">
          {onImageUpload && (
            <button
              type="button"
              className="desktop-conversation-btn"
              onClick={onImageUpload}
              title="Upload image"
              aria-label="Upload image"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
          )}

          {onInterrupt && (
            <button
              type="button"
              className="desktop-conversation-btn stop"
              onClick={onInterrupt}
              title="Ctrl+C"
              aria-label="Interrupt"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="1" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="desktop-conversation-send-btn"
            onClick={handleSend}
            disabled={!inputValue.trim()}
            aria-label="Send"
            title="Send"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
