/**
 * Canonical event types for structured CLI output.
 * Discriminated union — the `type` field determines the shape.
 * Every event carries `ts` (epoch ms) and `seq` (monotonic counter).
 */

// ── Base ──────────────────────────────────────────────────────────────

interface BaseEvent {
  type: string;
  ts: number;
  seq: number;
}

// ── Session lifecycle ─────────────────────────────────────────────────

export interface SessionStartedEvent extends BaseEvent {
  type: 'session_started';
  sessionId: string;
  provider: string;
}

export interface SessionEndedEvent extends BaseEvent {
  type: 'session_ended';
  sessionId: string;
  reason: 'completed' | 'error' | 'interrupted';
}

// ── Messages ──────────────────────────────────────────────────────────

export interface MessageStartedEvent extends BaseEvent {
  type: 'message_started';
  role: 'assistant' | 'user';
}

export interface MessageDeltaEvent extends BaseEvent {
  type: 'message_delta';
  role: 'assistant' | 'user';
  content: string;
}

export interface MessageCompletedEvent extends BaseEvent {
  type: 'message_completed';
  role: 'assistant' | 'user';
  content: string;
}

// ── Tool calls ────────────────────────────────────────────────────────

export interface ToolStartedEvent extends BaseEvent {
  type: 'tool_started';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolOutputEvent extends BaseEvent {
  type: 'tool_output';
  toolName: string;
  output: string;
  toolCallId?: string;
}

export interface ToolCompletedEvent extends BaseEvent {
  type: 'tool_completed';
  toolName: string;
  result: string;
  isError: boolean;
  toolCallId?: string;
}

// ── Interactive prompts ───────────────────────────────────────────────

export interface ApprovalRequiredEvent extends BaseEvent {
  type: 'approval_required';
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
}

export interface InputRequiredEvent extends BaseEvent {
  type: 'input_required';
  prompt: string;
}

// ── Status / errors ───────────────────────────────────────────────────

export interface StatusEvent extends BaseEvent {
  type: 'status';
  status: string;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  code?: string;
}

// ── Escape hatch ──────────────────────────────────────────────────────

export interface RawProviderEvent extends BaseEvent {
  type: 'raw_provider_event';
  provider: string;
  data: unknown;
}

// ── Union type ────────────────────────────────────────────────────────

export type CanonicalEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolOutputEvent
  | ToolCompletedEvent
  | ApprovalRequiredEvent
  | InputRequiredEvent
  | StatusEvent
  | ErrorEvent
  | RawProviderEvent;

export type CanonicalEventType = CanonicalEvent['type'];

// ── Helper ────────────────────────────────────────────────────────────

let _globalSeq = 0;

export function nextSeq(): number {
  return ++_globalSeq;
}

export function makeEvent<T extends CanonicalEvent>(
  partial: Omit<T, 'ts' | 'seq'> & { ts?: number; seq?: number }
): T {
  return {
    ...partial,
    ts: partial.ts ?? Date.now(),
    seq: partial.seq ?? nextSeq(),
  } as T;
}
