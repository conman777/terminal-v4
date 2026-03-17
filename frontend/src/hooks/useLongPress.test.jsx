import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLongPress } from './useLongPress';

describe('useLongPress', () => {
  it('clears the pending timeout on unmount', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();

    function TestComponent() {
      const handlers = useLongPress(onLongPress, 50);
      return <div data-testid="target" {...handlers} />;
    }

    try {
      const { getByTestId, unmount } = render(<TestComponent />);
      fireEvent.touchStart(getByTestId('target'), {
        touches: [{ clientX: 20, clientY: 30 }]
      });

      unmount();
      vi.advanceTimersByTime(60);

      expect(onLongPress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
