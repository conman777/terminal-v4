import { useState, useRef, useCallback } from 'react';

export function useScrollDirection(threshold = 30) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const scrollAccumulator = useRef(0);

  const handleScroll = useCallback((direction) => {
    // Accumulate scroll direction
    const delta = direction === 'down' ? 1 : -1;
    scrollAccumulator.current += delta * 10;

    // Clamp accumulator
    scrollAccumulator.current = Math.max(-threshold, Math.min(threshold, scrollAccumulator.current));

    // Trigger state change when threshold exceeded
    if (scrollAccumulator.current >= threshold && !isCollapsed) {
      setIsCollapsed(true);
    } else if (scrollAccumulator.current <= -threshold && isCollapsed) {
      setIsCollapsed(false);
    }
  }, [threshold, isCollapsed]);

  const reset = useCallback(() => {
    setIsCollapsed(false);
    scrollAccumulator.current = 0;
  }, []);

  return { isCollapsed, handleScroll, reset };
}
