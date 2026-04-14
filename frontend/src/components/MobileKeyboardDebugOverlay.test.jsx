import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileKeyboardDebugOverlay } from './MobileKeyboardDebugOverlay';

const apiPostMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiPost: (...args) => apiPostMock(...args)
}));

describe('MobileKeyboardDebugOverlay', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 402,
        offsetTop: 248,
        offsetLeft: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 402
    });
    Object.defineProperty(window, 'outerHeight', {
      configurable: true,
      value: 844
    });
  });

  it('posts snapshots to the mobile keyboard debug route when enabled', async () => {
    apiPostMock.mockResolvedValue({ ok: true });

    const layout = document.createElement('div');
    layout.className = 'layout mobile';
    document.body.appendChild(layout);

    render(
      <MobileKeyboardDebugOverlay
        enabled
        viewportHeight={402}
        keybarOpen={false}
        keybarHeight={0}
        mobileView="terminal"
        chatMode={false}
      />
    );

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/mobile-keyboard-debug',
        expect.objectContaining({
          visualViewportHeight: 402,
          visualViewportOffsetTop: 248,
          appViewportHeight: 402
        })
      );
    });
  });
});
