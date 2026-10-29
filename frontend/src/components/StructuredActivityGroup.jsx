import { useEffect, useState } from 'react';
import ToolCallBlock, { getToolDisplayInfo } from './ToolCallBlock';
import { V4ToolImages } from './V4ToolImages';
import { LightweightMarkdown } from './LightweightMarkdown';
import { formatWorkDuration, parsePlan } from '../utils/conversationWork';
import './StructuredActivityGroup.css';

const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

const SUMMARY_PHRASES = {
  read: count => `read ${plural(count, 'file')}`,
  edit: count => `edited ${plural(count, 'file')}`,
  search: count => plural(count, 'search', 'searches'),
  list: count => `listed files${count > 1 ? ` ${count} times` : ''}`,
  command: count => `ran ${plural(count, 'command')}`,
  web: count => plural(count, 'web lookup'),
  other: count => plural(count, 'tool call'),
};

export function summarizeActivity(messages) {
  const counts = new Map();
  for (const message of messages) {
    const info = getToolDisplayInfo({ tool: message.toolName, toolInput: message.toolInput });
    const kind = SUMMARY_PHRASES[info.kind] ? info.kind : 'other';
    counts.set(kind, (counts.get(kind) || 0) + (info.count || 1));
  }
  const text = [...counts].map(([kind, count]) => SUMMARY_PHRASES[kind](count)).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StructuredToolResult({ message: msg, sessionId }) {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const resultText = msg.result || content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    || (content.some(block => block?.type === 'v4_image') ? 'Image result' : '');
  return <>
    <ToolCallBlock item={{ type: 'tool_use', tool: msg.toolName, toolInput: msg.toolInput,
      result: { toolResult: resultText, isError: Boolean(msg.isError) } }} />
    <V4ToolImages sessionId={sessionId} content={content} />
  </>;
}

export function StructuredActivityGroup({ messages, sessionId, renderToolResult }) {
  const [open, setOpen] = useState(false);
  if (messages.length === 0) return null;
  const failed = messages.filter(message => message.isError).length;
  const summary = summarizeActivity(messages);
  return <details className="conversation-activity-group cc-structured-activity" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="activity-disclosure" aria-hidden="true">›</span>
      <span className="activity-summary-text" title={summary}>{summary}</span>
      {failed > 0 && <>{' '}<span className="activity-summary-failed">{failed} failed</span></>}
    </summary>
    {open && <div className="conversation-activity-items">{messages.map((message, index) => renderToolResult
      ? renderToolResult(message, index)
      : <StructuredToolResult key={message.toolCallId || message.messageId || index} message={message} sessionId={sessionId} />)}</div>}
  </details>;
}

export function StructuredWorkGroup({ durationMs, children }) {
  const [open, setOpen] = useState(false);
  return <div className={`conversation-work-group${open ? ' open' : ''}`}>
    <button type="button" className="conversation-work-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>{formatWorkDuration(durationMs)}</span>
      <span className="conversation-work-chevron" aria-hidden="true">›</span>
    </button>
    {open && <div className="conversation-work-items">{children}</div>}
  </div>;
}

// The agent's own thinking summary (Codex reasoning, Claude thinking), shown quietly like T3.
export function StructuredReasoning({ content }) {
  if (typeof content !== 'string' || !content.trim()) return null;
  return <div className="structured-reasoning">
    <span className="structured-reasoning-label">Thinking</span>
    <div className="structured-reasoning-text"><LightweightMarkdown content={content} linkClassName="md-link" /></div>
  </div>;
}

const PLAN_STATUS = {
  completed: { icon: '✓', label: 'Done' },
  inProgress: { icon: '●', label: 'In progress' },
  pending: { icon: '○', label: 'To do' },
};

// The agent's task list for the turn, updated in place as it works.
export function StructuredPlan({ content }) {
  const plan = parsePlan(content);
  if (!plan) return null;
  return <section className="structured-plan" aria-label="Plan">
    <span className="structured-plan-title">Plan</span>
    {plan.explanation && <p className="structured-plan-explanation">{plan.explanation}</p>}
    <ol className="structured-plan-steps">
      {plan.steps.map((step, index) => {
        const status = PLAN_STATUS[step.status] || PLAN_STATUS.pending;
        return <li key={index} className={`structured-plan-step status-${step.status}`}>
          <span className="structured-plan-icon" aria-hidden="true">{status.icon}</span>
          <span className="structured-plan-hidden">{status.label}: </span>
          <span>{step.step}</span>
        </li>;
      })}
    </ol>
  </section>;
}

// T3's live "Working for 12s" line while a turn runs.
export function StructuredWorking({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const label = Number.isFinite(since)
    ? formatWorkDuration(Math.max(0, now - since)).replace(/^Worked/, 'Working')
    : 'Working…';
  return <p className="structured-working" role="status">{label}</p>;
}
