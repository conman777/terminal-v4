import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileTerminalCarousel } from './MobileTerminalCarousel';

vi.mock('../hooks/useSwipeGesture', () => ({
  useSwipeGesture: () => ({ containerRef: { current: null } })
}));

vi.mock('./TerminalChat', () => ({
  TerminalChat: ({ sessionId }) => (
    <div data-testid="mobile-carousel-terminal">{sessionId}</div>
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
  });
});
