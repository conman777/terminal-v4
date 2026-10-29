import { describe, expect, it } from 'vitest';
import { getComposerPlaceholder, getStructuredAgentLabel } from './structuredSessions';

describe('getStructuredAgentLabel', () => {
  it('names the agent that owns each conversation', () => {
    const sessions = [{ runtime: 'codex', aiType: 'codex' }, { runtime: 'v4', aiType: 'openai-api' }, { aiType: 'claude' }, {}];
    expect(sessions.map(getStructuredAgentLabel)).toEqual(['Codex', 'V4', 'Claude Code', 'Agent']);
  });
});

describe('getComposerPlaceholder', () => {
  it('says where the message will go', () => {
    const placeholders = [
      getComposerPlaceholder({ isStructuredSession: true, session: { aiType: 'claude' } }),
      getComposerPlaceholder({ isStructuredSession: false, foregroundAiType: 'claude' }),
      getComposerPlaceholder({ isStructuredSession: false, foregroundAiType: null }),
    ];
    expect(placeholders).toEqual(['Message Claude Code…', 'Message Claude Code…', 'Type a terminal command…']);
  });
});
