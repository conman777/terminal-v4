import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClaudeCodePanel from './ClaudeCodePanel';

vi.mock('./TerminalChat', () => ({
  TerminalChat: ({ onViewportStateChange }) => (
    <div data-testid="claude-panel-terminal">
      <button type="button" onClick={() => onViewportStateChange?.(false)}>mark-terminal-scrolled-up</button>
      <button type="button" onClick={() => onViewportStateChange?.(true)}>mark-terminal-at-bottom</button>
    </div>
  )
}));

vi.mock('./MobileChatView', () => ({
  MobileChatView: ({ onViewportStateChange }) => (
    <div data-testid="claude-panel-chat">
      <button type="button" onClick={() => onViewportStateChange?.(false)}>mark-chat-scrolled-up</button>
      <button type="button" onClick={() => onViewportStateChange?.(true)}>mark-chat-at-bottom</button>
    </div>
  )
}));

vi.mock('../hooks/useMobileChatTurns', () => ({
  useMobileChatTurns: () => ({
    turns: [],
    isLoading: false,
    handleTurn: vi.fn(),
    handleRegisterSendText: vi.fn(),
    handleChatSend: vi.fn(),
    handleInterrupt: vi.fn(),
  })
}));

describe('ClaudeCodePanel', () => {
  const baseProps = {
    sessionId: 'claude-session',
    keybarOpen: false,
    viewportHeight: 800,
    onUrlDetected: vi.fn(),
    fontSize: 14,
    webglEnabled: true,
    onScrollDirection: vi.fn(),
    onRegisterFocusTerminal: vi.fn(),
    usesTmux: false,
  };

  it('forwards viewport state from the visible surface only', () => {
    const onViewportStateChange = vi.fn();
    const { rerender } = render(
      <ClaudeCodePanel
        {...baseProps}
        chatMode={false}
        onViewportStateChange={onViewportStateChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'mark-terminal-scrolled-up' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(false);

    rerender(
      <ClaudeCodePanel
        {...baseProps}
        chatMode={true}
        onViewportStateChange={onViewportStateChange}
      />
    );

    const callsBeforeHiddenTerminal = onViewportStateChange.mock.calls.length;
    fireEvent.click(screen.getByText('mark-terminal-scrolled-up'));
    expect(onViewportStateChange).toHaveBeenCalledTimes(callsBeforeHiddenTerminal);

    fireEvent.click(screen.getByRole('button', { name: 'mark-chat-scrolled-up' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'mark-chat-at-bottom' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(true);
  });
});
