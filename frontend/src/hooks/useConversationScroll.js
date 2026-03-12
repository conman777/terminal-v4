import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Derive a single primitive trigger from an array of dependency values.
 * When any value changes identity, the trigger string changes, which
 * fires the auto-scroll effect without spreading into the deps array.
 */
function useDepsSignature(deps) {
  const counterRef = useRef(0);
  const prevRef = useRef(deps);

  const changed = deps.length !== prevRef.current.length
    || deps.some((d, i) => d !== prevRef.current[i]);
  if (changed) {
    counterRef.current += 1;
    prevRef.current = deps;
  }

  return counterRef.current;
}

export function useConversationScroll({
  deps = [],
  bottomThreshold = 80,
  followBehavior = 'auto',
  onViewportStateChange,
} = {}) {
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const depsSignature = useDepsSignature(deps);
  const notifyViewportStateChange = useCallback((atBottom) => {
    onViewportStateChange?.(atBottom);
  }, [onViewportStateChange]);

  const scrollToBottom = useCallback((behavior = followBehavior) => {
    const element = bottomRef.current;
    if (!element || typeof element.scrollIntoView !== 'function') return;
    element.scrollIntoView({ behavior });
  }, [followBehavior]);

  const markShouldStickToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
    notifyViewportStateChange(true);
  }, [notifyViewportStateChange]);

  const jumpToBottom = useCallback((behavior = 'smooth') => {
    markShouldStickToBottom();
    scrollToBottom(behavior);
  }, [markShouldStickToBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < bottomThreshold;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
    notifyViewportStateChange(atBottom);
  }, [bottomThreshold, notifyViewportStateChange]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    scrollToBottom(followBehavior);
    notifyViewportStateChange(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followBehavior, notifyViewportStateChange, scrollToBottom, depsSignature]);

  return {
    containerRef,
    bottomRef,
    autoScrollRef,
    showScrollBtn,
    handleScroll,
    jumpToBottom,
    markShouldStickToBottom,
  };
}
