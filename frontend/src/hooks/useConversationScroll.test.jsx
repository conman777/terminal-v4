import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConversationScroll } from './useConversationScroll';

function setScrollMetrics(element, { scrollTop, scrollHeight, clientHeight }) {
  Object.defineProperty(element, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('useConversationScroll', () => {
  it('auto-scrolls only the message container while following the latest content', () => {
    const { result, rerender } = renderHook(
      ({ tick }) => useConversationScroll({ deps: [tick] }),
      { initialProps: { tick: 1 } }
    );

    const scrollIntoView = vi.fn();
    result.current.bottomRef.current = { scrollIntoView };
    const container = document.createElement('div');
    setScrollMetrics(container, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
    container.scrollTo = vi.fn();
    result.current.containerRef.current = container;

    rerender({ tick: 2 });

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'auto' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('shows the jump button and pauses auto-follow when scrolled away from the bottom', () => {
    const { result } = renderHook(() => useConversationScroll());

    const container = document.createElement('div');
    setScrollMetrics(container, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
    result.current.containerRef.current = container;

    act(() => {
      result.current.handleScroll();
    });

    expect(result.current.showScrollBtn).toBe(true);
    expect(result.current.autoScrollRef.current).toBe(false);
  });

  it('jumps to bottom smoothly when the user explicitly requests it', () => {
    const { result } = renderHook(() => useConversationScroll());
    const scrollIntoView = vi.fn();
    result.current.bottomRef.current = { scrollIntoView };
    const container = document.createElement('div');
    setScrollMetrics(container, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
    container.scrollTo = vi.fn();
    result.current.containerRef.current = container;

    act(() => {
      result.current.jumpToBottom();
    });

    expect(result.current.autoScrollRef.current).toBe(true);
    expect(result.current.showScrollBtn).toBe(false);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('reports viewport state when the user scrolls away and returns to bottom', () => {
    const onViewportStateChange = vi.fn();
    const { result } = renderHook(() => useConversationScroll({ onViewportStateChange }));

    const container = document.createElement('div');
    result.current.containerRef.current = container;

    act(() => {
      setScrollMetrics(container, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
      result.current.handleScroll();
    });

    act(() => {
      setScrollMetrics(container, { scrollTop: 521, scrollHeight: 1000, clientHeight: 400 });
      result.current.handleScroll();
    });

    expect(onViewportStateChange).toHaveBeenNthCalledWith(1, true);
    expect(onViewportStateChange).toHaveBeenNthCalledWith(2, false);
    expect(onViewportStateChange).toHaveBeenNthCalledWith(3, true);
  });
});
