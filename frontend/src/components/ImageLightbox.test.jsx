import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageLightbox } from './ImageLightbox';

const items = [{ src: '/one.png', alt: 'One' }, { src: '/two.png', alt: 'Two' }, { src: '/three.png', alt: 'Three' }];
const shown = () => screen.getByRole('dialog').querySelector('img').getAttribute('alt');
const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });
function swipe(from, to) {
  const viewport = screen.getByRole('dialog').querySelector('.md-lightbox-viewport');
  fireEvent.touchStart(viewport, touch(...from));
  fireEvent.touchEnd(viewport, touch(...to));
}

describe('ImageLightbox', () => {
  it('moves between images with arrow keys and stops at the ends', () => {
    render(<ImageLightbox items={items} initialIndex={0} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(shown()).toBe('One');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(shown()).toBe('Three');
  });

  it('closes on Escape without letting the key reach outer handlers', () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<ImageLightbox items={items} initialIndex={0} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('traps Tab focus inside the dialog', () => {
    render(<ImageLightbox items={items} initialIndex={0} onClose={() => {}} />);
    const buttons = screen.getByRole('dialog').querySelectorAll('a[href], button:not(:disabled)');
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('shows the next image after a left swipe and the previous after a right swipe', () => {
    render(<ImageLightbox items={items} initialIndex={1} onClose={() => {}} />);
    swipe([250, 100], [100, 110]);
    expect(shown()).toBe('Three');
    swipe([100, 100], [250, 105]);
    swipe([100, 100], [250, 105]);
    expect(shown()).toBe('One');
  });

  it('ignores short, mostly vertical and zoomed swipes', () => {
    render(<ImageLightbox items={items} initialIndex={1} onClose={() => {}} />);
    swipe([200, 100], [170, 100]);
    swipe([200, 100], [100, 300]);
    expect(shown()).toBe('Two');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    swipe([250, 100], [100, 100]);
    expect(shown()).toBe('Two');
  });

  it('ignores multi-finger gestures', () => {
    render(<ImageLightbox items={items} initialIndex={1} onClose={() => {}} />);
    const viewport = screen.getByRole('dialog').querySelector('.md-lightbox-viewport');
    fireEvent.touchStart(viewport, { touches: [{ clientX: 250, clientY: 100 }, { clientX: 260, clientY: 100 }] });
    fireEvent.touchEnd(viewport, touch(100, 100));
    expect(shown()).toBe('Two');
  });
});
