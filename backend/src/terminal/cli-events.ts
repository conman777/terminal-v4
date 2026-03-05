import type { ChatTurn } from './turn-detector';

export type TerminalCliEventType =
  | 'user_turn'
  | 'assistant_turn'
  | 'prompt_required'
  | 'status'
  | 'error';

export interface TerminalCliEventBase {
  type: TerminalCliEventType;
  ts: number;
  source: 'pty';
}

export interface TerminalCliTurnEvent extends TerminalCliEventBase {
  type: 'user_turn' | 'assistant_turn';
  content: string;
}

export interface TerminalCliPromptEvent extends TerminalCliEventBase {
  type: 'prompt_required';
  prompt: string;
  actions: string[];
}

export interface TerminalCliStatusEvent extends TerminalCliEventBase {
  type: 'status';
  status: string;
}

export interface TerminalCliErrorEvent extends TerminalCliEventBase {
  type: 'error';
  message: string;
}

export type TerminalCliEvent =
  | TerminalCliTurnEvent
  | TerminalCliPromptEvent
  | TerminalCliStatusEvent
  | TerminalCliErrorEvent;

export function buildCliTurnEvent(turn: ChatTurn): TerminalCliTurnEvent {
  return {
    type: turn.role === 'user' ? 'user_turn' : 'assistant_turn',
    content: turn.content,
    ts: turn.ts,
    source: 'pty'
  };
}

