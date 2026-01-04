import { useState, useRef, useCallback } from 'react';

export function useScrollDirection(threshold = 30) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const scrollAccumulator = useRef(0);
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;

  const handleScroll = useCallback((direction) => {
    // Accumulate scroll direction
    const delta = direction === 'down' ? 1 : -1;
    scrollAccumulator.current += delta * 10;

    // Clamp accumulator
    scrollAccumulator.current = Math.max(-threshold, Math.min(threshold, scrollAccumulator.current));

    // Trigger state change when threshold exceeded
    if (scrollAccumulator.current >= threshold && !isCollapsedRef.current) {
      setIsCollapsed(true);
    } else if (scrollAccumulator.current <= -threshold && isCollapsedRef.current) {
      setIsCollapsed(false);
    }
  }, [threshold]);

  const reset = useCallback(() => {
    setIsCollapsed(false);
    scrollAccumulator.current = 0;
  }, []);

  return { isCollapsed, handleScroll, reset };
}
