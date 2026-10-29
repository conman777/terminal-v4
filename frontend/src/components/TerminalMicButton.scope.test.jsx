import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalMicButton } from './TerminalMicButton';
import ClaudeCodeInput from './ClaudeCodeInput';

const { voice } = vi.hoisted(() => ({ voice: vi.fn() }));
vi.mock('../hooks/useVoiceInput', () => ({ useVoiceInput: voice }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({}) }));

describe('voice caller session scopes', () => {
  beforeEach(() => voice.mockReset().mockReturnValue({ toggleRecording: vi.fn() }));

  it('forwards the session identity while retaining the same microphone provider', () => {
    const view = render(<TerminalMicButton provider="local" sessionId="session-a" onTranscript={() => {}} />);
    expect(voice.mock.lastCall[1]).toEqual({ provider: 'local', scopeKey: 'session-a', available: true });
    view.rerender(<TerminalMicButton provider="local" sessionId="session-b" available={false} onTranscript={() => {}} />);
    expect(voice.mock.lastCall[1]).toEqual({ provider: 'local', scopeKey: 'session-b', available: false });
  });

  it('forwards conversation identity to both legacy composer voice providers', () => {
    const view = render(<ClaudeCodeInput sessionId="legacy-a" />);
    expect(voice.mock.calls.slice(-2).map(call => call[1])).toEqual([
      { provider: 'local', scopeKey: 'legacy-a' }, { provider: 'groq', scopeKey: 'legacy-a' },
    ]);
    view.rerender(<ClaudeCodeInput sessionId="legacy-b" />);
    expect(voice.mock.calls.slice(-2).map(call => call[1])).toEqual([
      { provider: 'local', scopeKey: 'legacy-b' }, { provider: 'groq', scopeKey: 'legacy-b' },
    ]);
  });
});
