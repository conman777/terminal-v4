import { useCallback, useEffect, useRef, useState } from 'react';

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
  }, [followBehavior, notifyViewportStateChange, scrollToBottom, ...deps]);

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
