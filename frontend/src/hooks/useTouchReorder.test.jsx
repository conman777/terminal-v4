import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTouchReorder } from './useTouchReorder';

const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], preventDefault: vi.fn() });

function setup(over = {}) {
  const onDrop = vi.fn();
  const hook = renderHook(() => useTouchReorder({ onDrop, ...over }));
  return { hook, onDrop };
}

describe('useTouchReorder', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); delete document.elementFromPoint; });

  it('arms a row after a long press and not before', () => {
    const { hook } = setup();
    const props = hook.result.current.bind('a', ['a', 'b']);
    act(() => props.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(300); });
    expect(hook.result.current.armedId).toBeNull();
    act(() => { vi.advanceTimersByTime(300); });
    expect(hook.result.current.armedId).toBe('a');
  });

  it('cancels the long press when the finger moves like a scroll', () => {
    const { hook } = setup();
    const props = hook.result.current.bind('a', ['a', 'b']);
    act(() => props.onTouchStart(touch(10, 10)));
    act(() => props.onTouchMove(touch(10, 40)));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(hook.result.current.armedId).toBeNull();
  });

  it('drops onto the sibling under the finger, after it when the finger is in the lower half', () => {
    const { hook, onDrop } = setup();
    const target = document.createElement('div');
    target.dataset.reorderId = 'b';
    target.getBoundingClientRect = () => ({ top: 100, height: 40 });
    document.elementFromPoint = () => target;
    const props = hook.result.current.bind('a', ['a', 'b']);
    act(() => props.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(600); });
    act(() => props.onTouchMove(touch(10, 130)));
    expect(hook.result.current.mark).toEqual({ id: 'b', after: true });
    act(() => props.onTouchEnd(touch(10, 130)));
    expect(onDrop).toHaveBeenCalledWith('a', 'b', true);
    expect(hook.result.current.armedId).toBeNull();
    expect(hook.result.current.mark).toBeNull();
  });

  it('ignores targets that are not siblings', () => {
    const { hook, onDrop } = setup();
    const target = document.createElement('div');
    target.dataset.reorderId = 'x';
    target.getBoundingClientRect = () => ({ top: 0, height: 40 });
    document.elementFromPoint = () => target;
    const props = hook.result.current.bind('a', ['a', 'b']);
    act(() => props.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(600); });
    act(() => props.onTouchMove(touch(10, 20)));
    act(() => props.onTouchEnd(touch(10, 20)));
    expect(onDrop).not.toHaveBeenCalled();
    expect(hook.result.current.armedId).toBe('a');
  });

  it('suppresses the click that follows a long press and can be disarmed', () => {
    const { hook } = setup();
    const props = hook.result.current.bind('a', ['a', 'b']);
    act(() => props.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(600); });
    act(() => props.onTouchEnd(touch(10, 10)));
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    props.onClickCapture(click);
    expect(click.preventDefault).toHaveBeenCalled();
    act(() => hook.result.current.disarm());
    expect(hook.result.current.armedId).toBeNull();
  });
});
