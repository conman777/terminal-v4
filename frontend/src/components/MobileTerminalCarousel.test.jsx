import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileTerminalCarousel } from './MobileTerminalCarousel';

let latestTerminalChatProps = null;

vi.mock('../utils/windowActivity', () => ({
  isWindowActive: () => true,
  subscribeWindowActivity: () => () => {}
}));

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    listSessionGitBranches: vi.fn().mockResolvedValue({ currentBranch: 'main', branches: ['main', 'feature/mobile'] }),
    checkoutSessionGitBranch: vi.fn()
  })
}));

vi.mock('../hooks/useSwipeGesture', () => ({
  useSwipeGesture: () => ({ containerRef: { current: null } })
}));

vi.mock('./TerminalChat', () => ({
  TerminalChat: (props) => {
    latestTerminalChatProps = props;
    const { sessionId, onViewportStateChange, onRegisterScrollToBottom } = props;
    return (
    <div data-testid="mobile-carousel-terminal">
      {sessionId}
      <button type="button" onClick={() => onViewportStateChange?.(false)}>mark-terminal-scrolled-up</button>
      <button type="button" onClick={() => onViewportStateChange?.(true)}>mark-terminal-at-bottom</button>
      <button type="button" onClick={() => onRegisterScrollToBottom?.(vi.fn())}>register-scroll</button>
      <button type="button" onClick={() => props.onConnectionChange?.(true)}>mark-connected</button>
      <button type="button" onClick={() => props.onConnectionChange?.(false)}>mark-disconnected</button>
    </div>
    );
  }
}));

vi.mock('./MobileChatView', () => ({
  MobileChatView: ({ onViewportStateChange }) => (
    <div data-testid="mobile-carousel-chat">
      <button type="button" onClick={() => onViewportStateChange?.(false)}>mark-chat-scrolled-up</button>
      <button type="button" onClick={() => onViewportStateChange?.(true)}>mark-chat-at-bottom</button>
    </div>
  )
}));

vi.mock('./MobileStatusBar', () => ({
  MobileStatusBar: ({ sessionId }) => (
    <div data-testid="mobile-carousel-status">{sessionId}</div>
  )
}));

describe('MobileTerminalCarousel', () => {
  it('can transition from empty sessions to an active session without hook-order crashes', () => {
    const onIndexChange = vi.fn();
    const props = {
      currentIndex: 0,
      onIndexChange,
      keybarOpen: false,
      viewportHeight: 800,
      onUrlDetected: vi.fn(),
      fontSize: 14,
      webglEnabled: true,
      onScrollDirection: vi.fn(),
      onRegisterFocusTerminal: vi.fn(),
      onSessionBusyChange: vi.fn()
    };

    const { rerender } = render(
      <MobileTerminalCarousel
        {...props}
        sessions={[]}
      />
    );

    expect(screen.getByText('Welcome to Terminal')).toBeInTheDocument();

    expect(() => {
      rerender(
        <MobileTerminalCarousel
          {...props}
          sessions={[{ id: 'session-1', usesTmux: false }]}
        />
      );
    }).not.toThrow();

    expect(screen.getByTestId('mobile-carousel-terminal')).toHaveTextContent('session-1');
    expect(screen.getByTestId('mobile-carousel-status')).toHaveTextContent('session-1');
    expect(latestTerminalChatProps?.surface).toBe('mobile');
  });

  it('shows and hides the jump-to-latest button from actual viewport state', () => {
    render(
      <MobileTerminalCarousel
        currentIndex={0}
        onIndexChange={vi.fn()}
        keybarOpen={false}
        viewportHeight={800}
        onUrlDetected={vi.fn()}
        fontSize={14}
        webglEnabled={true}
        onScrollDirection={vi.fn()}
        onRegisterFocusTerminal={vi.fn()}
        onSessionBusyChange={vi.fn()}
        sessions={[{ id: 'session-1', usesTmux: false }]}
      />
    );

    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mark-terminal-scrolled-up' }));
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mark-terminal-at-bottom' }));
    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument();
  });

  it('only forwards viewport state from the visible mobile pane', () => {
    const onViewportStateChange = vi.fn();
    const props = {
      currentIndex: 0,
      onIndexChange: vi.fn(),
      keybarOpen: false,
      viewportHeight: 800,
      onUrlDetected: vi.fn(),
      fontSize: 14,
      webglEnabled: true,
      onScrollDirection: vi.fn(),
      onRegisterFocusTerminal: vi.fn(),
      onSessionBusyChange: vi.fn(),
      sessions: [{ id: 'session-1', usesTmux: false }],
      onViewportStateChange,
    };

    const { rerender } = render(<MobileTerminalCarousel {...props} chatMode={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'mark-terminal-scrolled-up' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(false);

    rerender(<MobileTerminalCarousel {...props} chatMode={true} />);

    const callsBeforeHiddenTerminal = onViewportStateChange.mock.calls.length;
    fireEvent.click(screen.getByText('mark-terminal-scrolled-up'));
    expect(onViewportStateChange).toHaveBeenCalledTimes(callsBeforeHiddenTerminal);

    fireEvent.click(screen.getByRole('button', { name: 'mark-chat-scrolled-up' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'mark-chat-at-bottom' }));
    expect(onViewportStateChange).toHaveBeenLastCalledWith(true);
  });

  it('does not show disconnected before the first successful connection', () => {
    render(
      <MobileTerminalCarousel
        currentIndex={0}
        onIndexChange={vi.fn()}
        keybarOpen={false}
        viewportHeight={800}
        onUrlDetected={vi.fn()}
        fontSize={14}
        webglEnabled={true}
        onScrollDirection={vi.fn()}
        onRegisterFocusTerminal={vi.fn()}
        onSessionBusyChange={vi.fn()}
        sessions={[{ id: 'session-1', usesTmux: false }]}
      />
    );

    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mark-disconnected' }));
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mark-connected' }));
    fireEvent.click(screen.getByRole('button', { name: 'mark-disconnected' }));
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });
});
