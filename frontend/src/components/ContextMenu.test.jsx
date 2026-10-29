import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';

describe('ContextMenu keyboard interaction', () => {
  it('keeps the action list inside the visual viewport after resize', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 180, height: 160 });
    const previousViewport = window.visualViewport;
    const viewport = new EventTarget();
    Object.assign(viewport, { width: 320, height: 240, offsetLeft: 0, offsetTop: 100 });
    window.visualViewport = viewport;
    try {
      const { container } = render(<ContextMenu x={300} y={300} onClose={vi.fn()} items={[{ label: 'Rename', onClick: vi.fn() }]} />);
      const menu = container.firstChild;
      expect(menu).toHaveStyle({ left: '132px', top: '172px' });
      viewport.height = 200;
      fireEvent(viewport, new Event('resize'));
      expect(menu).toHaveStyle({ top: '132px', maxHeight: '184px' });
    } finally {
      window.visualViewport = previousViewport;
      bounds.mockRestore();
    }
  });

  it('focuses available actions, wraps arrow navigation, and restores focus on Escape', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { unmount } = render(<ContextMenu x={12} y={12} onClose={onClose} items={[
      { label: 'Unavailable', disabled: true },
      { label: 'Rename', onClick: vi.fn() },
      { separator: true },
      { label: 'Delete', onClick: vi.fn() },
    ]} />);
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
