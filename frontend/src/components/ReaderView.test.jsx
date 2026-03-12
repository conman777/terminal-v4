import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderView } from './ReaderView';

describe('ReaderView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    });
  });

  it('focuses the desktop reader container instead of the hidden input on click', () => {
    render(
      <ReaderView
        content="example"
        lines={null}
        fontSize={12}
        lineHeight={null}
        scrollToken={0}
        onInput={vi.fn()}
        isMobile={false}
      />
    );

    const container = document.querySelector('.reader-view');
    const input = document.querySelector('.reader-view-mobile-input');

    const containerFocus = vi.spyOn(container, 'focus').mockImplementation(() => {});
    const inputFocus = vi.spyOn(input, 'focus').mockImplementation(() => {});

    fireEvent.click(screen.getByText('example'));

    expect(containerFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(inputFocus).not.toHaveBeenCalled();
  });
});
