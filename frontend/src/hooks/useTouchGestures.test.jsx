import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTouchGestures } from './useTouchGestures';

describe('useTouchGestures', () => {
  it('clears the long-press timer on unmount', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();

    function TestComponent() {
      const {
        handleTouchCancelCapture,
        handleTouchEndCapture,
        handleTouchMoveCapture,
        handleTouchStartCapture
      } = useTouchGestures(true, null, { onLongPress, longPressMs: 50 });
      return (
        <div
          data-testid="target"
          onTouchCancelCapture={handleTouchCancelCapture}
          onTouchEndCapture={handleTouchEndCapture}
          onTouchMoveCapture={handleTouchMoveCapture}
          onTouchStartCapture={handleTouchStartCapture}
        />
      );
    }

    try {
      const { getByTestId, unmount } = render(<TestComponent />);
      fireEvent.touchStart(getByTestId('target'), {
        touches: [{ clientX: 10, clientY: 10 }]
      });

      unmount();
      vi.advanceTimersByTime(60);

      expect(onLongPress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels long press when the finger drifts beyond the shared move threshold', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onTap = vi.fn();

    function TestComponent() {
      const {
        handleTouchCancelCapture,
        handleTouchEndCapture,
        handleTouchMoveCapture,
        handleTouchStartCapture
      } = useTouchGestures(true, onTap, { onLongPress, longPressMs: 50 });
      return (
        <div
          data-testid="target"
          onTouchCancelCapture={handleTouchCancelCapture}
          onTouchEndCapture={handleTouchEndCapture}
          onTouchMoveCapture={handleTouchMoveCapture}
          onTouchStartCapture={handleTouchStartCapture}
        />
      );
    }

    try {
      const { getByTestId } = render(<TestComponent />);
      const target = getByTestId('target');

      fireEvent.touchStart(target, {
        touches: [{ clientX: 10, clientY: 10 }]
      });
      fireEvent.touchMove(target, {
        touches: [{ clientX: 21, clientY: 10 }]
      });
      vi.advanceTimersByTime(60);
      fireEvent.touchEnd(target, {
        changedTouches: [{ clientX: 21, clientY: 10 }]
      });

      expect(onLongPress).not.toHaveBeenCalled();
      expect(onTap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
