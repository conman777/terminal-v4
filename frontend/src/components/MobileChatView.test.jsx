import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileChatView } from './MobileChatView';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark' })
}));

vi.mock('./TerminalMicButton', () => ({
  TerminalMicButton: () => <div data-testid="mobile-chat-mic" />
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
  uploadScreenshot: vi.fn()
}));

function buildProps(overrides = {}) {
  return {
    turns: [],
    isStreaming: false,
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onImageUpload: vi.fn(),
    sessionId: 'session-1',
    isLoadingHistory: false,
    aiType: 'codex',
    runtimeInfo: { providerId: 'codex', label: 'gpt-5.5 xhigh' },
    connectionState: 'online',
    isSendReady: true,
    terminalPreview: 'gpt-5.5 xhigh · ~/terminal-v4 Goal achieved',
    terminalScreenSnapshot: '',
    customAiProviders: [],
    ...overrides
  };
}

describe('MobileChatView', () => {
  it('renders an AI-aware mobile empty state instead of the old Claude copy', () => {
    render(<MobileChatView {...buildProps()} />);

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.5 xhigh')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Codex...')).toBeInTheDocument();
    expect(screen.queryByText(/Message Claude/i)).not.toBeInTheDocument();
  });

  it('filters Codex launch commands and terminal transcript noise from mobile chat turns', () => {
    const transcriptDump = [
      ...Array.from({ length: 28 }, (_, index) => `• Ran npm test ${index} (ctrl + t to view transcript)`),
      'I found the mobile issue. The chat view was still using the old Claude-only shell.',
      'The fix makes the mobile Codex view use the same clean conversation rules.',
      '377 +    if (hasCodexCompletionBoundary(stripped)) {',
      '489 +  if (turns.length === 0 && hasCodexSessionEvidence(stripped)) {'
    ].join('\n');

    render(
      <MobileChatView
        {...buildProps({
          turns: [
            { role: 'user', content: 'codex --yolo', ts: 1 },
            { role: 'assistant', content: transcriptDump, ts: 2 }
          ]
        })}
      />
    );

    expect(screen.queryByText(/codex --yolo/i)).not.toBeInTheDocument();
    expect(screen.getByText(/old Claude-only shell/i)).toBeInTheDocument();
    expect(screen.queryByText(/hasCodexCompletionBoundary/i)).not.toBeInTheDocument();
  });
});
