import { StructuredActivityGroup, StructuredPlan, StructuredReasoning, StructuredToolResult, StructuredWorkGroup, StructuredWorking } from './StructuredActivityGroup';
import { attachTurnChanges, groupTurnWork } from '../utils/conversationWork';
import { TurnChangesCard } from './TurnChangesCard';
import { PlanActions } from './PlanActions';
import { attachPlanActions, isPlanMessage, stripPlanMarker } from '../utils/planMode';
import { forkPrompt } from '../utils/conversationFork';
import { canReadAloud, readAloud } from '../utils/readAloud';
import { useTurnChanges } from '../hooks/useTurnChanges';
import './DesktopConversationView.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ToolCallBlock, { getToolDisplayInfo, sessionTodoResult } from './ToolCallBlock';
import { getBrowserToolDisplayInfo } from '../utils/browserToolPresentation';
import { V4UserImages } from './V4UserImages';
import { AgentQuestionCard } from './AgentQuestionCard';
import { PrivateOutputReview } from './PrivateOutputReview';
import { COMMON_LAUNCH_PREFIXES, getAiDisplayLabel, normalizeAiType } from '../utils/aiProviders';
import { useConversationScroll } from '../hooks/useConversationScroll';
import { parseInteractivePromptSnapshot, parseInteractivePromptEvent } from '../utils/interactivePrompt';
import { workspaceKeyboardBlocked } from '../utils/workspaceKeyboardScope';
import { foldedMessageKey, registerFoldedSearchGroup } from '../utils/foldedConversationSearch';
import { ProjectFilePreview } from './ProjectFilePreview';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { environmentAllows } from '../utils/runtimePermissions';

function UncertainApprovalReview({ approval, onReview, disabled, isStreaming }) {
  const [checked, setChecked] = useState(false);
  return <div className="cc-message cc-assistant"><div className="cc-assistant-bubble">
    <div className="structured-approval-prompt" role="group" aria-label="Uncertain approval decision">
      <div className="structured-approval-title" role="status">Approval decision needs review</div>
      <p>The decision may have been delivered. Stop the session and inspect the action and its results before continuing.</p>
      <p>{approval.description || approval.prompt || `Action: ${approval.toolName}`}</p>
      {approval.toolInput && <pre className="structured-approval-input" tabIndex={0} aria-label="Approval details" data-conversation-scroll-region>{JSON.stringify(approval.toolInput, null, 2)}</pre>}
      {approval.reviewUnavailable ? <p>This server cannot safely acknowledge the decision. Stop the session, inspect the terminal, and use a new conversation if further work is needed.</p> : <p>Acknowledging records your review; it does not resend or reverse the decision. Start a new request if further work is needed.</p>}
      {isStreaming && <p>Stop the session before acknowledging this review.</p>}
      {!approval.reviewUnavailable && <><label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> I inspected the action and understand the decision may have been delivered.</label>
        <div className="desktop-interactive-prompt-actions"><button type="button" className="desktop-interactive-action secondary" disabled={!checked || disabled || isStreaming || !onReview} onClick={() => onReview?.(approval)}>Acknowledge review</button></div></>}
    </div>
  </div></div>;
}

function SearchableWorkGroup({ items, durationMs, renderItem }) {
  const group = useRef(null);
  const searchable = items.flatMap(item => {
    if (['user', 'assistant', 'reasoning', 'plan'].includes(item.role)) return [item];
    if (item.role !== 'activity') return [];
    return item.messages.flatMap(message => {
      const content = Array.isArray(message.content) ? message.content : [];
      const output = message.result || content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
      const info = getToolDisplayInfo({ tool: message.toolName, toolInput: message.toolInput });
      const edit = ['edit', 'replace_text'].includes(message.toolName?.toLowerCase());
      const diff = edit && typeof info.oldString === 'string' && typeof info.newString === 'string';
      const tasks = message.toolName?.toLowerCase() === 'todo_list' && !message.isError && typeof output === 'string' ? sessionTodoResult(output) : null;
      const diffText = diff ? (info.oldString === info.newString ? ['No changes'] : [
        ...(info.oldString ? info.oldString.split('\n').map(line => `-${line}`) : []),
        ...(info.newString ? info.newString.split('\n').map(line => `+${line}`) : []),
      ]) : [];
      const visibleOutput = typeof output === 'string' && (!diff || message.isError) ? output : '';
      return visibleOutput || diffText.length ? [{ role: 'tool', toolCallId: message.toolCallId, content: visibleOutput, searchText: [...diffText, ...(tasks?.map(task => task.content) || [])], original: message }] : [];
    });
  });
  useLayoutEffect(() => registerFoldedSearchGroup(group.current, searchable), [items]);
  return <div ref={group}>
    {searchable.map((item, index) => <span key={foldedMessageKey(item)} hidden
      data-folded-search-index={index} data-folded-message-id={(item.role === 'user' || item.role === 'assistant') ? item.messageId || undefined : undefined}
      data-folded-message-role={item.messageId && (item.role === 'user' || item.role === 'assistant') ? item.role : undefined} />)}
    <StructuredWorkGroup durationMs={durationMs}>{items.map((item, index) => {
      const searchIndex = searchable.indexOf(item);
      if (item.role === 'activity') {
        const indexes = item.messages.map(message => searchable.findIndex(entry => entry.original === message));
        const valid = indexes.filter(value => value >= 0);
        return <div key={`activity-${index}`} data-folded-activity-start={valid[0]} data-folded-activity-end={valid.at(-1)}>{renderItem(item, index, indexes)}</div>;
      }
      return searchIndex < 0 ? renderItem(item, index) : <div key={foldedMessageKey(item)} data-folded-render-index={searchIndex}>{renderItem(item, index)}</div>;
    })}</StructuredWorkGroup>
  </div>;
}

const CODEX_MODEL_RE = /\bgpt-5(?:\.\d+)?\b/i;
const CODEX_MODEL_SQUASHED_RE = /gpt-5(?:\.\d+)?/i;

function looksLikeSourceCodeLine(line) {
  return /\b(?:const|let|var|function|return|export|import|if)\b/.test(line)
    || /(?:=>|\.match\(|\.test\(|expect\(|screen\.|queryByText|getByText|toBeInTheDocument|toHaveTextContent|\/\*|\*\/)/.test(line);
}

function compactText(value) {
  return value.toLowerCase().replace(/\s+/g, '');
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

function isCodeFragmentTurn(content) {
  const trimmed = content.trim();
  if (trimmed.length > 24) return false;
  if (/[A-Za-z]{3,}/.test(trimmed) && /\s/.test(trimmed)) return false;
  if (!/[{}()[\];=]/.test(trimmed)) return false;
  return !/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(trimmed);
}

function looksLikeWrappedPromptEcho(content, recentUserContent) {
  if (!recentUserContent) return false;

  const lines = String(content || '')
    .split('\n')
    .map((line) => normalizeTranscriptReplyLine(line))
    .filter(Boolean);
  if (lines.length === 0) return false;

  const allChunky = lines.every((line) => line.length <= 8 && !/[.!?]$/.test(line));
  if (!allChunky) return false;

  const promptFingerprint = echoChunkFingerprint(recentUserContent);
  const echoFingerprint = echoChunkFingerprint(lines.join(''));
  return echoFingerprint.length >= 3 && promptFingerprint.length >= 8 && promptFingerprint.includes(echoFingerprint);
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
    || (CODEX_MODEL_SQUASHED_RE.test(squashed) && (squashed.includes('100%left') || /(?:xhigh|high|medium|low)/.test(squashed)))
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
    || CODEX_MODEL_SQUASHED_RE.test(squashed)
    || squashed.includes('session/')
    || squashed.includes('today/')
    || squashed.includes('/hr')
    || squashed.includes('%left')
    || /\$\d/.test(line);
  return hasStatusMarkers && hasModelOrUsage;
}

function stripModelStatusFooter(line) {
  return line
    .replace(/\s+(?:[|│]\s*)?(?:[🪟💰🔥🧠]\s*)?(?:Opus 4\.6|Sonnet 4\.6|gpt-5(?:\.\d+)?)\b[\s\S]*$/i, '')
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

function looksLikeRawTranscriptDump(content) {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  const lineCount = lines.length;
  if (trimmed.length < 1200 && lineCount < 28) return false;
  const markerHits = [
    /\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)/i,
    /\bRan\s+(?:git|npm|node|curl|ss|rg|cat|sed|cargo|python|pnpm|yarn)\b/i,
    /\bRead\s+[^|\n]+(?:\+?\d+\s+lines|\d+\s+chars)/i,
    /\bEdited\s+[^|\n]+\+?\d+\s+lines/i,
    /\bCommit\s+[a-f0-9]{7,}/i,
    /\bpushed?\s+to\s+(?:origin|github|https?:\/\/)/i,
  ].reduce((count, pattern) => count + (pattern.test(trimmed) ? 1 : 0), 0);
  const commandishLines = lines.filter((line) => (
    /\b(?:Ran|Read|Edited|Wrote|Commit|Pushed|Opened|Searched)\b/.test(line)
    || /\b(?:git|npm|node|curl|rg|sed)\s+/.test(line)
  )).length;

  return markerHits >= 2 || commandishLines >= 6 || lineCount >= 28;
}

function normalizeTranscriptReplyLine(line) {
  return String(line || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\(B/g, '')
    .replace(/›?\s*Use \/skills to list available skills[\s\S]*$/i, '')
    .replace(/\bgpt-5(?:\.\d+)?\b[\s\S]*?\bGoal achieved\b[\s\S]*$/i, '')
    .replace(/─+\s*Worked for[\s\S]*$/i, '')
    .replace(/\s*\(ctrl\s*\+\s*t\s+to\s+view\s+transcript\)\s*/ig, ' ')
    .replace(/[┌┐└┘├┤─│╭╮╰╯═]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[●•]\s*/, '')
    .trim();
}

function looksLikeTranscriptActivityLine(line) {
  const trimmed = normalizeTranscriptReplyLine(line);
  if (!trimmed) return true;
  if (looksLikeSourceCodeLine(trimmed)) return true;
  if (/^[A-Za-z]?\s*[✓✔□☐☑]\s+/.test(trimmed)) return true;
  if (/^\d+\s+[+-]\s/.test(trimmed)) return true;
  if (/^[+-]\s*(?:const|let|var|function|return|export|import|if|else|for|while|try|catch)\b/.test(trimmed)) return true;
  if (/^\d+\s{2,}.*[{}();=]/.test(trimmed)) return true;
  if (/^(?:@@|[⋮│])/.test(trimmed)) return true;
  if (/^\d+\s+more\b/i.test(trimmed)) return true;
  if (/^\+\d+\s+lines\b/i.test(trimmed)) return true;
  if (/^⎿/.test(trimmed)) return true;
  if (/^name:\s*['"]?TimeoutError/i.test(trimmed)) return true;
  if (/\bTimeoutError\b/i.test(trimmed)) return true;
  if (/^\(no output\)/i.test(trimmed)) return true;
  if (/\bWorking\s*\(/i.test(trimmed)) return true;
  if (/Use \/skills to list available skills/i.test(trimmed)) return true;
  if (/\bgpt-5(?:\.\d+)?\b/i.test(trimmed) && /\bgoal achieved\b/i.test(trimmed)) return true;
  if (/https?:\/\/\S+\/api\/client-build/i.test(trimmed)) return true;
  if (/"buildId"\s*:\s*"\/assets\//i.test(trimmed)) return true;
  if (/\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)/i.test(trimmed)) return true;
  if (/^index-[A-Za-z0-9_-]+\.(?:js|css)\b/i.test(trimmed)) return true;
  if (/index-\[A-Za-z0-9_-\]\+/i.test(trimmed)) return true;
  if (/…\s*\+\d+\s+lines/i.test(trimmed)) return true;
  if (/^\}\s*$/.test(trimmed)) return true;
  return [
    /^(?:Ran|Read|Edited|Wrote|Opened|Searched|Commit|Committed|Pushed|Updated Plan)\b/i,
    /^(?:Bash|Read|Search|Update|Write|Edit)\(/i,
    /^(?:git|npm|pnpm|yarn|node|curl|ss|rg|cat|sed|cargo|python|pytest|vitest|systemctl|sudo)\s+/i,
    /\b\/bin\/systemctl\b/i,
    /\b(?:tests?\s+passed|tests?\s+failed|passed|failed)\b/i,
  ].some((pattern) => pattern.test(trimmed));
}

function looksLikeHardTranscriptActivityLine(line) {
  const trimmed = normalizeTranscriptReplyLine(line).replace(/^[●•]\s*/, '');
  if (!trimmed) return true;
  if (looksLikeSourceCodeLine(trimmed)) return true;
  if (/^[A-Za-z]?\s*[✓✔□☐☑]\s+/.test(trimmed)) return true;
  if (/^\d+\s+[+-]\s/.test(trimmed)) return true;
  if (/^[+-]\s*(?:const|let|var|function|return|export|import|if|else|for|while|try|catch)\b/.test(trimmed)) return true;
  if (/^\d+\s{2,}.*[{}();=]/.test(trimmed)) return true;
  if (/^(?:@@|[⋮│])/.test(trimmed)) return true;
  if (/^\d+\s+more\b/i.test(trimmed)) return true;
  if (/^\+\d+\s+lines\b/i.test(trimmed)) return true;
  if (/^⎿/.test(trimmed)) return true;
  if (/^name:\s*['"]?TimeoutError/i.test(trimmed)) return true;
  if (/\bTimeoutError\b/i.test(trimmed)) return true;
  if (/^\(no output\)/i.test(trimmed)) return true;
  if (/\bWorking\s*\(/i.test(trimmed)) return true;
  if (/^Use \/skills to list available skills/i.test(trimmed)) return true;
  if (/\bgpt-5(?:\.\d+)?\b/i.test(trimmed) && /\bgoal achieved\b/i.test(trimmed)) return true;
  if (/https?:\/\/\S+\/api\/client-build/i.test(trimmed)) return true;
  if (/"buildId"\s*:\s*"\/assets\//i.test(trimmed)) return true;
  if (/…\s*\+\d+\s+lines/i.test(trimmed)) return true;
  if (/^\}\s*$/.test(trimmed)) return true;
  return [
    /^(?:Ran|Read|Edited|Wrote|Opened|Searched|Commit|Committed|Pushed|Updated Plan|Viewed Image|Explored)\b/i,
    /^(?:Bash|Read|Search|Update|Write|Edit)\(/i,
    /^(?:git|npm|pnpm|yarn|node|curl|ss|rg|cat|sed|cargo|python|pytest|vitest|systemctl|sudo)\s+/i,
    /\b\/bin\/systemctl\b/i,
  ].some((pattern) => pattern.test(trimmed));
}

function cleanTranscriptResponseLine(line) {
  return normalizeTranscriptReplyLine(line)
    .replace(/^[●•]\s*/, '')
    .trim();
}

function looksLikeAssistantReplyStart(line) {
  const trimmed = cleanTranscriptResponseLine(line).replace(/^[-*]\s+/, '');
  if (trimmed.length < 8) return false;
  return /^(?:I\b|I've\b|I’m\b|I found\b|I fixed\b|Found\b|Fixed\b|Done\b|Verified\b|What changed\b|The bugs were\b|The fix\b|Now\b|Committed and pushed\b)/i.test(trimmed);
}

function shouldStartNewTranscriptResponseBlock(line) {
  const trimmed = cleanTranscriptResponseLine(line).replace(/^[-*]\s+/, '');
  return /^(?:I\b|I've\b|I’m\b|I found\b|I fixed\b|Found\b|Fixed\b|Done\b|What changed\b)/i.test(trimmed);
}

function formatTranscriptResponseBlock(rawLines) {
  const formattedLines = [];

  for (const rawLine of rawLines) {
    const cleaned = cleanTranscriptResponseLine(rawLine);
    if (!cleaned) continue;

    const isListItem = /^[-*]\s+/.test(cleaned);
    const isSectionHeading = /^[A-Z][A-Za-z0-9 &/-]+:$/.test(cleaned);
    const isContinuation = /^\s{2,}\S/.test(String(rawLine || '')) && !isListItem;
    const previous = formattedLines[formattedLines.length - 1] || '';

    if (
      isContinuation
      && !isSectionHeading
      && previous
      && (previous.startsWith('- ') || !/[.:!?]$/.test(previous))
    ) {
      formattedLines[formattedLines.length - 1] = `${previous} ${cleaned}`.replace(/\s+/g, ' ');
      continue;
    }

    if (formattedLines[formattedLines.length - 1] !== cleaned) {
      formattedLines.push(cleaned);
    }
  }

  return formattedLines
    .join('\n')
    .replace(
      /rendered as repeated assistant\s+cards\.lies plus repeated\s+(“Terminal activity”)/i,
      'rendered as repeated assistant replies plus repeated $1 cards.'
    )
    .replace(
      /rendered as repeated assistant replies plus\s+cards\.eated\s+(“Terminal activity”)/i,
      'rendered as repeated assistant replies plus repeated $1 cards.'
    )
    .trim();
}

function scoreTranscriptResponseBlock(text, index) {
  const normalized = text.toLowerCase();
  let score = Math.min(text.length, 1600) + index;

  if (/^i fixed what your screenshots showed/im.test(text)) score += 800;
  if (/\bthe bugs were:/i.test(text)) score += 500;
  if (/\bverified:/i.test(text)) score += 450;
  if (/\bcommitted and pushed:/i.test(text)) score += 350;
  if (/\bfrontend tests:\s*\d+\s+passed/i.test(text)) score += 250;
  if (/\bbackend .*tests:\s*\d+\s+passed/i.test(text)) score += 250;
  if (/\bmobile smoke test:/i.test(text)) score += 180;
  if (/\bclean codex transcript rendering\b/i.test(text)) score += 180;

  if (/\bcards\.(?:lies|eated)\b/i.test(text)) score -= 1000;
  if (/\b[a-z]{3,}\.[a-z]{3,}\b/.test(normalized)) score -= 250;
  if (normalized.includes('edited frontend/src') || normalized.includes('function ')) score -= 700;
  if (normalized.includes('const ') || normalized.includes('expect(')) score -= 400;

  return score;
}

function extractBestAssistantResponseBlock(content) {
  const candidates = [];
  let currentBlock = [];

  const flush = () => {
    if (currentBlock.length === 0) return;
    const text = formatTranscriptResponseBlock(currentBlock);
    currentBlock = [];
    if (text.length >= 36) {
      candidates.push(text);
    }
  };

  for (const rawLine of String(content || '').split('\n')) {
    const startsReply = looksLikeAssistantReplyStart(rawLine);
    const hardActivity = looksLikeHardTranscriptActivityLine(rawLine);

    if (hardActivity && !startsReply) {
      flush();
      continue;
    }

    if (startsReply) {
      if (currentBlock.length > 0 && shouldStartNewTranscriptResponseBlock(rawLine)) {
        flush();
      }
      currentBlock.push(rawLine);
      continue;
    }

    if (currentBlock.length > 0) {
      currentBlock.push(rawLine);
    }
  }

  flush();

  if (candidates.length === 0) return '';

  return candidates
    .map((text, index) => ({ text, score: scoreTranscriptResponseBlock(text, index) }))
    .sort((a, b) => b.score - a.score)[0]?.text || '';
}

function looksLikeUsefulTranscriptReplyLine(line) {
  const trimmed = normalizeTranscriptReplyLine(line);
  if (trimmed.length < 12) return false;
  if (looksLikeTranscriptActivityLine(line)) return false;
  if (/^(?:Inspect|Clean generated artifacts|Run tests|Commit and push)\b/i.test(trimmed)) return false;
  const hasSentenceSignal = /[.!?]$/.test(trimmed)
    || /\b(?:I|I've|I’m|I found|The fix|Done|Fixed|Verified|Committed|Pushed|Mobile changes|Latest-build behavior)\b/i.test(trimmed);
  if (!hasSentenceSignal) return false;

  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  return letters / trimmed.length > 0.45;
}

function extractLatestAssistantReplyFromRawTranscript(content) {
  if (typeof content !== 'string') return '';

  const bestResponseBlock = extractBestAssistantResponseBlock(content);
  if (bestResponseBlock) return bestResponseBlock;

  const blocks = [];
  let currentBlock = [];
  for (const rawLine of content.split('\n')) {
    if (looksLikeUsefulTranscriptReplyLine(rawLine)) {
      currentBlock.push(normalizeTranscriptReplyLine(rawLine));
      continue;
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const latestBlock = [...blocks].reverse().find((block) => block.join(' ').length >= 36);
  if (!latestBlock) return '';

  return latestBlock.slice(-10).join('\n').trim();
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
  let lastMeaningfulUserContent = '';
  let pendingActivityTurn = null;
  let assistantFingerprintsForCurrentUser = new Set();

  const flushPendingActivity = () => {
    if (!pendingActivityTurn) return;
    visibleTurns.push(pendingActivityTurn);
    pendingActivityTurn = null;
  };

  const pushAssistantTurn = (turn, content) => {
    const fingerprint = visibleContentFingerprint(content);
    if (fingerprint.length >= 16 && assistantFingerprintsForCurrentUser.has(fingerprint)) return;
    if (fingerprint.length >= 16) assistantFingerprintsForCurrentUser.add(fingerprint);
    visibleTurns.push({ ...turn, role: 'assistant', content });
  };

  for (const turn of turns) {
    if (!turn || typeof turn.content !== 'string') continue;

    if (turn.role === 'user') {
      const userContent = turn.content.trim();
      if (!userContent) continue;
      if (isLaunchCommand(userContent, aiType)) continue;
      if (isSlashCommandOnlyTurn(userContent)) continue;
      if (isShortFragmentTurn(userContent)) continue;
      if (isCodeFragmentTurn(userContent)) continue;
      if (looksLikeWrappedPromptEcho(userContent, lastMeaningfulUserContent)) continue;
      flushPendingActivity();
      hasMeaningfulUserTurn = true;
      lastMeaningfulUserContent = userContent;
      assistantFingerprintsForCurrentUser = new Set();
      visibleTurns.push({ ...turn, content: userContent });
      continue;
    }

    if (turn.role === 'assistant') {
      const rawAssistantContent = turn.content;
      const assistantContent = sanitizeAssistantTurnContent(turn.content, aiType);
      if (!assistantContent && !looksLikeRawTranscriptDump(rawAssistantContent)) continue;
      if (assistantContent && looksLikeWrappedPromptEcho(assistantContent, lastMeaningfulUserContent)) continue;
      if (looksLikeRawTranscriptDump(rawAssistantContent) || looksLikeRawTranscriptDump(assistantContent)) {
        const latestReply = extractLatestAssistantReplyFromRawTranscript(rawAssistantContent);
        if (latestReply) {
          pushAssistantTurn(turn, latestReply);
        }
        pendingActivityTurn = { ...turn, role: 'assistant_activity', content: assistantContent || rawAssistantContent };
        continue;
      }
      if (!hasMeaningfulUserTurn && looksLikeBootstrapNoiseText(assistantContent)) continue;
      flushPendingActivity();
      pushAssistantTurn(turn, assistantContent);
      continue;
    }

    flushPendingActivity();
    visibleTurns.push(turn);
  }

  flushPendingActivity();
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
      ? [CODEX_MODEL_RE]
      : aiType === 'gemini'
        ? [/\bGemini\b/i, /\b(context|ctx|token)\b/i]
        : [/\b(Opus 4\.6|Sonnet 4\.6|Claude Max|gpt-5(?:\.\d+)?|Gemini)\b/i];

  return lines.find((line) => !looksLikeSourceCodeLine(line) && runtimePatterns.every((pattern) => pattern.test(line))) || '';
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
    case 'Waiting for approval':
    case 'Waiting for your answer':
    case 'Cleanup required':
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
  pendingApproval,
  requiresCleanup,
  isStreaming,
  isOffline,
  connectionState,
  isSendReady,
  showTerminalMirror,
}) {
  if (requiresCleanup) return 'Cleanup required';
  if (pendingApproval?.toolName === 'ask_user') return 'Waiting for your answer';
  if (pendingApproval) return 'Waiting for approval';
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

const STRUCTURED_MESSAGE_OUTCOMES = {
  streaming: 'Partial response',
  cancelled: 'Stopped — partial response',
  interrupted: 'Stopped — partial response',
  failed: 'Failed — partial response',
  unconfirmed: 'Completion not confirmed — partial response',
};

function sameToolArguments(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameToolArguments(left[key], right[key]));
}

function findApprovalToolIndex(approval, tools) {
  if (!approval) return -1;
  const approvalInfo = getToolDisplayInfo({ tool: approval.toolName, toolInput: approval.toolInput });
  const exactMatches = [];
  const fallbackMatches = [];
  tools.forEach((tool, index) => {
    const identities = ['approvalId', 'toolCallId', 'requestId', 'turnId'];
    const shared = identities.filter(key => approval[key] != null && tool[key] != null);
    if (shared.some(key => approval[key] !== tool[key])) return;
    if (shared.includes('toolCallId') || shared.includes('approvalId')) {
      exactMatches.push(index);
      return;
    }
    const info = getToolDisplayInfo({ tool: tool.toolName, toolInput: tool.toolInput });
    const sameTool = (info.browserTool || tool.toolName) === (approvalInfo.browserTool || approval.toolName);
    if (sameTool && tool.toolName && sameToolArguments(tool.toolInput || {}, approval.toolInput || {})) fallbackMatches.push(index);
  });
  const matches = exactMatches.length ? exactMatches : fallbackMatches;
  return matches.length === 1 ? matches[0] : -1;
}

export function DesktopConversationView({
  turns,
  showHeader = true,
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
  browserApprovals = [],
  onBrowserApprove,
  isBrowserApproving = false,
  browserApprovalError = '',
  onApprove = null,
  onReviewApproval = null,
  isApproving = false,
  isInterrupting = false,
  requiresCleanup = false,
  actionError = '',
  allowPromptKeyboardCapture = false,
  workspacePath = '',
  allowApprovalForSession = false,
  privateReviewVisible = true,
  filePreviewVisible = true,
  onRevealProjectFile,
  onImplementPlan,
  onImplementPlanInNewThread,
  onEditMessage,
  onForkFromMessage,
  onDiffComment,
}) {
  const [filePreview, setFilePreview] = useState(null);
  useEffect(() => {
    setFilePreview(null);
    const auth = captureAuthScope();
    const unsubscribeAuth = subscribeAuth(() => { if (!isAuthScopeCurrent(auth)) setFilePreview(null); });
    const unsubscribeEnvironment = subscribeEnvironment(() => setFilePreview(null));
    return () => { unsubscribeAuth(); unsubscribeEnvironment(); };
  }, [sessionId, workspacePath, filePreviewVisible]);
  const timeline = [];
  for (const message of structuredMessages) {
    const previous = timeline[timeline.length - 1];
    if (message.role === 'tool' && previous?.role === 'activity') previous.messages.push(message);
    else if (message.role === 'tool') timeline.push({ role: 'activity', messages: [message] });
    else timeline.push(message);
  }
  const assistantLabel = getAiDisplayLabel(aiType) || 'Assistant';
  const isStructured = mode === 'structured';
  const canPreviewFiles = Boolean(isStructured && sessionId && workspacePath && filePreviewVisible && environmentAllows(getActiveEnvironment(), 'transfer'));
  const openProjectFile = canPreviewFiles ? file => setFilePreview({ sessionId, root: workspacePath, file }) : undefined;
  const turnChanges = useTurnChanges(isStructured ? sessionId : null, isStreaming);
  const approvalInfo = pendingApproval ? getToolDisplayInfo({ tool: pendingApproval.toolName, toolInput: pendingApproval.toolInput }) : null;
  const scheduleReview = ['create_schedule', 'manage_schedule'].includes(pendingApproval?.toolName)
    && pendingApproval?.toolInput?.schedule && typeof pendingApproval.toolInput.schedule === 'object';
  const delegationReview = pendingApproval?.toolName === 'delegate_task_background'
    && pendingApproval.toolInput?.permission === 'read_only_child'
    && ['prompt', 'workspace', 'provider', 'model'].every(key => typeof pendingApproval.toolInput[key] === 'string');
  const scheduleReviewText = pendingApproval?.toolName === 'create_schedule'
    ? 'Create this unattended schedule?'
    : [['pause', 'Pause this schedule?'], ['resume', 'Resume this schedule?'], ['run', 'Run this schedule now? An unattended task will start.'], ['remove', 'Remove this schedule? Existing tasks will continue.']].find(([action]) => action === pendingApproval?.toolInput?.action)?.[1] || 'Review this schedule action.';
  const approvalToolIndex = isStructured ? findApprovalToolIndex(pendingApproval, structuredToolCalls) : -1;
  const browserApprovalToolIndices = new Set(isStructured ? browserApprovals.map(row => findApprovalToolIndex({ ...row, toolName: row.name, toolInput: row.arguments }, structuredToolCalls)) : []);
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
  const activityTurns = isStructured ? [] : displayTurns.filter((turn) => turn.role === 'assistant_activity');
  const conversationTurns = isStructured ? [] : displayTurns.filter((turn) => turn.role !== 'assistant_activity');
  const isConnected = connectionState === 'online';
  const isOffline = connectionState === 'offline';
  const statusLabel = getStatusLabel({
    interactivePrompt,
    pendingApproval: isStructured ? pendingApproval || browserApprovals.length > 0 : null,
    requiresCleanup,
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
    || browserApprovals.length > 0
  );
  const hasVisibleConversationTurns = conversationTurns.length > 0;
  const hasVisibleTurns = displayTurns.length > 0 || hasStructuredActivity;
  const showStartupCard = !hasVisibleConversationTurns && !hasStructuredActivity && !isLoadingHistory;
  const showTerminalStartupCard = !isStructured && !hasVisibleConversationTurns && !isLoadingHistory;
  const latestLiveTranscriptReply = !isStructured && !hasVisibleConversationTurns && !isLoadingHistory && !interactivePrompt
    ? extractLatestAssistantReplyFromRawTranscript(terminalPreview)
    : '';
  const showInlineInteractivePrompt = showInteractivePromptBlock && !showTerminalStartupCard;
  const shouldRenderHeader = showHeader && !showTerminalStartupCard;
  const showPromptCopyInStartupPanel = !(showTerminalStartupCard && isTerminalDockVisible);
  const showTerminalPreviewInStartupCard = Boolean(terminalPreview)
    && !(showTerminalStartupCard && isTerminalDockVisible)
    && !(showTerminalStartupCard && aiType);
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
        : hasVisibleConversationTurns
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
    deps: [turns, structuredMessages, structuredToolCalls, pendingApproval, browserApprovals, isStreaming],
    followBehavior: 'auto',
  });

  useEffect(() => {
    if (!shouldCaptureRawKeyboard) return undefined;

    const handleGlobalKeyDown = (event) => {
      const target = event.target;
      if (workspaceKeyboardBlocked(target)) return;
      const isInput = target instanceof HTMLInputElement;
      const isTextarea = target instanceof HTMLTextAreaElement;
      const isEditable = isInput || isTextarea || Boolean(target?.isContentEditable);
      if (target?.closest?.('button, a[href], summary, select, [role="button"], [role="menuitem"], [role="tab"]')) return;
      if (target?.closest?.('[data-conversation-scroll-region]')) return;
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
    <div className="desktop-conversation-view mode-conversation" data-conversation-session-id={sessionId}>
      {canPreviewFiles && filePreview?.sessionId === sessionId && filePreview.root === workspacePath && <ProjectFilePreview
        sessionId={sessionId} root={workspacePath} file={filePreview.file} onClose={() => setFilePreview(null)} onShowInFiles={onRevealProjectFile} />}
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
              {isStructured && (isStreaming || requiresCleanup) && <>
                <button type="button" className="desktop-agent-action" aria-label={requiresCleanup ? "Retry cancellation" : "Stop response"} onClick={() => onInterrupt?.()} disabled={!onInterrupt || isInterrupting}>{requiresCleanup ? "Retry cancellation" : "Stop response"}</button>
                {isInterrupting && <span role="status">Stopping response…</span>}
              </>}
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

      <div className={`desktop-conversation-body${activityTurns.length > 0 ? ' has-activity-window' : ''}`}>
        <div ref={containerRef} className="desktop-thread" onScroll={handleScroll}>
          <div className={`desktop-thread-inner${showTerminalStartupCard ? ' live-session-layout' : ''}`}>
          {actionError && !(isStructured && (pendingApproval || browserApprovals.length > 0)) && <div className="desktop-agent-inline-notice" role="alert">{actionError}</div>}
          {isStructured && !pendingApproval && browserApprovals.length === 0 && browserApprovalError && browserApprovalError !== actionError && <div className="desktop-agent-inline-notice" role="alert">{browserApprovalError}</div>}
          {conversationNotice && conversationNotice !== actionError && (
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
            <div className="desktop-conversation-empty" role="status">Loading conversation history...</div>
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

              {showTerminalStartupCard && latestLiveTranscriptReply && (
                <div className="desktop-agent-latest-reply">
                  <span className="desktop-cli-focus-section-label">Latest reply</span>
                  <p className="desktop-agent-latest-reply-copy">{latestLiveTranscriptReply}</p>
                </div>
              )}

              {!showTerminalStartupCard && (
                <p className="dcv-startup-text">
                  <span className="dcv-startup-msg">{startupMessage}</span>
                </p>
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

          {conversationTurns.map((turn, index) => (
            <ToolCallBlock
              key={`${turn.ts ?? index}-${turn.role}-${index}`}
              item={{ type: turn.role, content: turn.content, roleLabel: assistantLabel }}
            />
          ))}

          {isStructured && attachTurnChanges(attachPlanActions(groupTurnWork(timeline, { inProgress: isStreaming }), { inProgress: isStreaming }), turnChanges).map(function renderTimelineItem(msg, index, searchIndexes) {
            if (!searchIndexes?.every(value => typeof value === 'number')) searchIndexes = undefined;
            if (msg.role === 'plan-actions') return <PlanActions key={`s-plan-${msg.key}`} plan={msg.plan} disabled={isStreaming}
              onImplement={onImplementPlan} onImplementInNewThread={onImplementPlanInNewThread} />;
            if (msg.role === 'turn-changes') return <TurnChangesCard key={`s-changes-${msg.turnId}`} changes={msg.changes} workspacePath={workspacePath} onComment={onDiffComment} />;
            if (msg.role === 'work') {
              const first = msg.items[0];
              return <SearchableWorkGroup key={`s-work-${first?.messageId || first?.messages?.[0]?.toolCallId || index}`}
                items={msg.items} durationMs={msg.durationMs} renderItem={renderTimelineItem} />;
            }
            if (msg.role === 'user') {
              return (
                <div key={`s-user-${msg.messageId || msg.requestId || `${msg.ts ?? index}-${index}`}`} data-message-id={msg.messageId} data-message-role="user" tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget) autoScrollRef.current = false; }}>
                <ToolCallBlock
                  item={{ type: 'user', copyText: stripPlanMarker(msg.content),
                    actions: onEditMessage && typeof msg.content === 'string' ? [{ label: 'Edit as new message', onClick: () => onEditMessage(stripPlanMarker(msg.content)) }] : [],
                    content: <>{isPlanMessage(msg.content) && <span className="cc-plan-chip">Plan</span>}{stripPlanMarker(msg.content)}{Array.isArray(msg.attachments) && msg.attachments.length > 0
                    && <V4UserImages sessionId={sessionId} attachments={msg.attachments} />}</> }}
                />
                </div>
              );
            }
            if (msg.role === 'assistant') {
              const outcome = STRUCTURED_MESSAGE_OUTCOMES[msg.completionStatus];
              return (
                <div key={`s-assistant-${msg.messageId || `${msg.ts ?? index}-${index}`}`} data-message-id={msg.messageId} data-message-role="assistant" tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget) autoScrollRef.current = false; }}>
                  <ToolCallBlock workspacePath={workspacePath} onProjectFileClick={openProjectFile} item={{ type: 'assistant', content: msg.content, roleLabel: assistantLabel,
                    actions: [
                      ...(canReadAloud() && typeof msg.content === 'string' && msg.content ? [{ label: 'Read aloud', onClick: () => readAloud(msg.content) }] : []),
                      ...(onForkFromMessage && msg.messageId && !isStreaming ? [{ label: 'Fork from here', onClick: () => onForkFromMessage(forkPrompt(structuredMessages, msg.messageId)) }] : []),
                    ] }} />
                  {outcome && <p className="structured-message-outcome" role="status">{outcome}</p>}
                </div>
              );
            }
            if (msg.role === 'reasoning') return <StructuredReasoning key={`s-reasoning-${msg.messageId || index}`} content={msg.content} />;
            if (msg.role === 'plan') return <StructuredPlan key={`s-plan-${msg.messageId || index}`} content={msg.content} />;
            if (msg.role === 'activity') {
              const first = msg.messages[0];
              const key = `s-tool-${first.turnId || ''}-${first.toolCallId || index}`;
              const renderToolResult = (message, toolIndex) => <div key={message.toolCallId || message.messageId || toolIndex} data-folded-render-index={searchIndexes?.[toolIndex] >= 0 ? searchIndexes[toolIndex] : undefined}>
                <StructuredToolResult message={message} sessionId={sessionId} workspacePath={workspacePath} onProjectFileClick={openProjectFile} />
              </div>;
              return msg.messages.length > 1
                ? <StructuredActivityGroup key={key} messages={msg.messages} sessionId={sessionId} workspacePath={workspacePath} onProjectFileClick={openProjectFile} renderToolResult={searchIndexes ? renderToolResult : undefined} />
                : searchIndexes ? renderToolResult(first, 0) : <StructuredToolResult key={key} message={first} sessionId={sessionId} workspacePath={workspacePath} onProjectFileClick={openProjectFile} />;
            }
            if (msg.role === 'error') {
              return (
                <div key={`s-${msg.ts ?? index}-error-${index}`} className="cc-message cc-error">
                  <div className="cc-error-bubble" role="alert">{msg.content}</div>
                </div>
              );
            }
            return null;
          })}

          {isStructured && structuredToolCalls.length > 0 && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                {structuredToolCalls.map((tc, i) => {
                  const toolInfo = getToolDisplayInfo({ tool: tc.toolName, toolInput: tc.toolInput });
                  const awaitingApproval = i === approvalToolIndex || browserApprovalToolIndices.has(i);
                  if (awaitingApproval && !tc.result) return null;
                  return (
                    <div key={`tc-${tc.turnId || ''}-${tc.toolCallId || i}`} className="structured-tool-running">
                      {!awaitingApproval && <span className="structured-tool-running-line" role="status">
                        {requiresCleanup || !isStreaming ? 'Awaiting confirmation for' : 'Running'} <strong>{toolInfo.title}</strong>
                        {toolInfo.detail && <> <code className="structured-tool-running-detail" title={toolInfo.input || undefined}>{toolInfo.detail}</code></>}…
                      </span>}
                      {!awaitingApproval && toolInfo.browserTool && <details className="structured-tool-details">
                        <summary>Details</summary>
                        <code>{toolInfo.rawTool}</code>
                        {toolInfo.server && <p>Server: <code>{toolInfo.server}</code></p>}
                        <pre tabIndex={0} aria-label="Tool arguments" data-conversation-scroll-region>{toolInfo.input || '{}'}</pre>
                      </details>}
                      {tc.result && <pre className="structured-tool-partial" tabIndex={0} aria-label="Partial tool output" data-conversation-scroll-region>{tc.result}</pre>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {isStructured && isStreaming && !pendingApproval && browserApprovals.length === 0 && !requiresCleanup && !isInterrupting && (
            <StructuredWorking since={structuredMessages.findLast(message => message.role === 'user')?.ts} />
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

        {activityTurns.length > 0 && (
          <aside className="desktop-activity-window" aria-label="Terminal activity">
            <div className="desktop-activity-window-scroll">
              {activityTurns.map((turn, index) => (
                <ToolCallBlock
                  key={`activity-${turn.ts ?? index}-${index}`}
                  item={{ type: turn.role, content: turn.content, roleLabel: assistantLabel }}
                />
              ))}
            </div>
          </aside>
        )}
      </div>

      {isStructured && (pendingApproval || browserApprovals.length > 0) && (
        <section className={`desktop-pending-requests${delegationReview ? ' has-delegation-review' : ''}`} aria-label="Pending requests">
          {actionError && <div className="desktop-agent-inline-notice" role="alert">{actionError}</div>}
          {browserApprovalError && browserApprovalError !== actionError && <div className="desktop-agent-inline-notice" role="alert">{browserApprovalError}</div>}
          {isStructured && browserApprovals.map(row => {
            const input = row.arguments || {};
            const info = getBrowserToolDisplayInfo(row.name, input);
            const detail = info?.detail || (Object.keys(input).length ? JSON.stringify(input, null, 2) : '');
            const disabled = !onBrowserApprove || isBrowserApproving || isApproving || isInterrupting || requiresCleanup;
            return <div key={`browser-approval-${row.id}`} className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className="structured-approval-prompt structured-browser-approval" role="group" aria-label="Browser approval required">
                  <div className="structured-approval-title" role="status">Waiting for approval</div>
                  <p className="structured-approval-question">{info ? `${info.title}?` : `Approve ${row.name}?`}</p>
                  {row.target?.url && <p className="structured-browser-approval-page">Page: {row.target.url}</p>}
                  {detail && <pre className="structured-approval-arguments" tabIndex={0} aria-label="Action arguments" data-conversation-scroll-region>{detail}</pre>}
                  <details className="structured-tool-details">
                    <summary>Details</summary>
                    <p>Tool: <code>{row.name}</code></p>
                    <p>Requested by: <code>{row.label}</code></p>
                    <p>Request: <code>{row.id}</code></p>
                    <pre className="structured-approval-input" tabIndex={0} aria-label="Browser approval details" data-conversation-scroll-region>{JSON.stringify(input, null, 2)}</pre>
                    {row.target && <pre className="structured-approval-input" tabIndex={0} aria-label="Browser approval target" data-conversation-scroll-region>{JSON.stringify(row.target, null, 2)}</pre>}
                  </details>
                  {!onBrowserApprove && <p className="structured-approval-help">Approval actions are unavailable in this view.</p>}
                  {requiresCleanup && <p className="structured-approval-help">Complete cancellation before responding to this approval.</p>}
                  {isBrowserApproving && <p role="status">Submitting browser approval decision…</p>}
                  <div className="desktop-interactive-prompt-actions">
                    <button type="button" className="desktop-interactive-action primary" onClick={() => onBrowserApprove?.(row.id, true)} disabled={disabled}>Approve</button>
                    <button type="button" className="desktop-interactive-action secondary" onClick={() => onBrowserApprove?.(row.id, false)} disabled={disabled}>Reject</button>
                  </div>
                </div>
              </div>
            </div>;
          })}

          {isStructured && (pendingApproval?.decisionUncertain || pendingApproval?.decisionUnconfirmed) && <UncertainApprovalReview key={pendingApproval.approvalId} approval={pendingApproval} onReview={onReviewApproval} isStreaming={isStreaming} disabled={isApproving || isBrowserApproving || isInterrupting || requiresCleanup} />}

          {isStructured && !pendingApproval?.decisionUncertain && !pendingApproval?.decisionUnconfirmed && pendingApproval?.toolName === 'ask_user' && Array.isArray(pendingApproval.toolInput?.questions) && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className="structured-approval-prompt" role="group" aria-label="Question from the agent">
                  <div className="structured-approval-title" role="status">{pendingApproval.description || 'The agent has a question for you.'}</div>
                  <AgentQuestionCard key={pendingApproval.approvalId || pendingApproval.seq} questions={pendingApproval.toolInput.questions}
                    disabled={!onApprove || isApproving || isBrowserApproving || isInterrupting || requiresCleanup}
                    onAnswer={answers => onApprove?.(true, pendingApproval, answers)}
                    onDismiss={() => onApprove?.(false, pendingApproval)} />
                  {isApproving && <p role="status">Sending your answer…</p>}
                </div>
              </div>
            </div>
          )}

          {isStructured && privateReviewVisible && pendingApproval?.toolName === 'background_read_output' && !pendingApproval.decisionUncertain && !pendingApproval.decisionUnconfirmed && (
            <div className="cc-message cc-assistant"><div className="cc-assistant-bubble">
              <PrivateOutputReview key={`${sessionId}:${pendingApproval.approvalId}`} sessionId={sessionId} approval={pendingApproval}
                disabled={!onApprove || isApproving || isBrowserApproving || isInterrupting || requiresCleanup}
                onReject={onApprove ? approval => onApprove(false, approval) : undefined} />
            </div></div>
          )}

          {isStructured && pendingApproval && !pendingApproval.decisionUncertain && !pendingApproval.decisionUnconfirmed && !['ask_user', 'background_read_output'].includes(pendingApproval.toolName) && (
            <div className="cc-message cc-assistant">
              <div className="cc-assistant-bubble">
                <div className={`structured-approval-prompt${approvalInfo.browserTool ? ' structured-browser-approval' : ''}`} role="group" aria-label="Approval required">
                  <div className="structured-approval-title" role="status">Waiting for approval</div>
                  {delegationReview ? <>
                    <p className="structured-approval-question">Run a read-only background investigation?</p>
                    <dl className="structured-delegation-fields">
                      <div><dt>Task</dt><dd><pre tabIndex={0} data-conversation-scroll-region>{pendingApproval.toolInput.prompt}</pre></dd></div>
                      <div><dt>Project</dt><dd><pre className="structured-delegation-project" tabIndex={0} data-conversation-scroll-region>{pendingApproval.toolInput.workspace}</pre></dd></div>
                      <div><dt>Model</dt><dd>{pendingApproval.toolInput.provider} · {pendingApproval.toolInput.model}</dd></div>
                    </dl>
                    <p className="structured-approval-help">No shell, writes or external tools. {pendingApproval.toolInput.authorization || pendingApproval.toolInput.paired_authorization
                      ? 'A new empty queue can run the result automatically while your authorization remains valid; other held queues need resume.'
                      : 'If delivered, the result is held for review; otherwise check the retained task.'}</p>
                    <details className="structured-tool-details">
                      <summary>More details</summary>
                      <pre className="structured-approval-input" tabIndex={0} aria-label="Approval details" data-conversation-scroll-region>{JSON.stringify(pendingApproval.toolInput, null, 2)}</pre>
                    </details>
                  </> : approvalInfo.browserTool ? <>
                    <p className="structured-approval-question">{approvalInfo.title}?</p>
                    {approvalInfo.detail && <pre className="structured-approval-arguments" tabIndex={0} aria-label="Action arguments" data-conversation-scroll-region>{approvalInfo.detail}</pre>}
                    <details className="structured-tool-details" key={`${pendingApproval.turnId || ''}:${pendingApproval.approvalId || pendingApproval.toolCallId || pendingApproval.seq || pendingApproval.toolName}`}>
                      <summary>Details</summary>
                      <p>Tool: <code>{pendingApproval.toolName}</code></p>
                      {(pendingApproval.server || pendingApproval.serverName || approvalInfo.server) && <p>Server: <code>{pendingApproval.server || pendingApproval.serverName || approvalInfo.server}</code></p>}
                      {(pendingApproval.description || pendingApproval.prompt) && <p>{pendingApproval.description || pendingApproval.prompt}</p>}
                      {pendingApproval.toolInput != null && <pre className="structured-approval-input" tabIndex={0} aria-label="Approval details" data-conversation-scroll-region>{JSON.stringify(pendingApproval.toolInput, null, 2)}</pre>}
                    </details>
                  </> : <>
                    {['background_start', 'background_write', 'background_write_bytes', 'background_close_input'].includes(pendingApproval.toolName) && pendingApproval.description
                      ? <><pre className="structured-approval-input" tabIndex={0} aria-label="Background action review" data-conversation-scroll-region>{pendingApproval.description}</pre><p className="structured-approval-help">Scroll to review the full request before deciding.</p></>
                      : <p>{scheduleReview ? scheduleReviewText : pendingApproval.description || pendingApproval.prompt || `Approve ${pendingApproval.toolName}?`}</p>}
                    {pendingApproval.toolInput && ['background_start', 'background_write', 'background_write_bytes', 'background_close_input'].includes(pendingApproval.toolName) ? (
                      <details className="structured-tool-details"><summary>Action details</summary><pre className="structured-approval-input" tabIndex={0} aria-label="Approval details" data-conversation-scroll-region>{JSON.stringify(pendingApproval.toolInput, null, 2)}</pre></details>
                    ) : pendingApproval.toolInput && (
                      <pre className="structured-approval-input" tabIndex={0} aria-label="Approval details" data-conversation-scroll-region>{JSON.stringify(pendingApproval.toolInput, null, 2)}</pre>
                    )}
                    {scheduleReview && pendingApproval.description && <details className="structured-tool-details"><summary>Full approval description</summary><pre tabIndex={0} data-conversation-scroll-region>{pendingApproval.description}</pre></details>}
                  </>}
                  {!onApprove && <p className="structured-approval-help">Approval actions are unavailable in this view.</p>}
                  {requiresCleanup && <p className="structured-approval-help">Complete cancellation before responding to this approval.</p>}
                  {isApproving && <p role="status">Submitting approval decision…</p>}
                  <div className="desktop-interactive-prompt-actions">
                    <button
                      type="button"
                      className="desktop-interactive-action primary"

                      onClick={() => onApprove?.(true, pendingApproval)}
                      disabled={!onApprove || isApproving || isBrowserApproving || isInterrupting || requiresCleanup}
                    >
                      Approve
                    </button>
                    {allowApprovalForSession && !approvalInfo.browserTool && !pendingApproval.toolName?.startsWith('background_') && <button
                      type="button"
                      className="desktop-interactive-action secondary"
                      onClick={() => onApprove?.(true, pendingApproval, undefined, { forSession: true })}
                      disabled={!onApprove || isApproving || isBrowserApproving || isInterrupting || requiresCleanup}
                    >
                      Allow for this session
                    </button>}
                    <button
                      type="button"
                      className="desktop-interactive-action secondary"

                      onClick={() => onApprove?.(false, pendingApproval)}
                      disabled={!onApprove || isApproving || isBrowserApproving || isInterrupting || requiresCleanup}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </section>
      )}

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
