import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewProvider, usePreview } from './PreviewContext';

vi.mock('../utils/previewUrl', () => ({
  extractPortFromUrl: vi.fn((url) => {
    if (!url) return null;
    const match = String(url).match(/:(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
  }),
  getActivePortsInfo: vi.fn(async () => [
    { port: 5173, listening: true },
    { port: 3020, listening: true },
  ]),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(async (url) => {
    if (url === '/api/settings') {
      return {
        ok: true,
        json: async () => ({ previewUrl: '' }),
      };
    }

    if (url === '/api/system/preview-config') {
      return {
        ok: true,
        json: async () => ({}),
      };
    }

    return {
      ok: true,
      json: async () => ({}),
    };
  }),
}));

function PreviewConsumer() {
  const { previewUrl, handlePreviewUrlChange } = usePreview();

  return (
    <div>
      <span data-testid="preview-url">{previewUrl || 'none'}</span>
      <button type="button" onClick={() => handlePreviewUrlChange('/preview/5173/app')}>
        set-valid-preview
      </button>
      <button type="button" onClick={() => handlePreviewUrlChange('http://localhost:3020/')}>
        set-app-origin
      </button>
    </div>
  );
}

describe('PreviewContext', () => {
  let originalWindow;

  beforeEach(() => {
    originalWindow = window;
    localStorage.clear();
  });

  afterEach(() => {
    vi.stubGlobal('window', originalWindow);
    localStorage.clear();
  });

  it('ignores attempts to replace an existing preview with the app origin', async () => {
    const fakeWindow = Object.create(window);
    Object.defineProperty(fakeWindow, 'location', {
      value: {
        ...window.location,
        hostname: 'localhost',
        port: '3020',
        protocol: 'http:',
        origin: 'http://localhost:3020',
      },
    });
    vi.stubGlobal('window', fakeWindow);

    render(
      <PreviewProvider>
        <PreviewConsumer />
      </PreviewProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'set-valid-preview' }));

    await waitFor(() => {
      expect(screen.getByTestId('preview-url')).toHaveTextContent('/preview/5173/app');
    });

    fireEvent.click(screen.getByRole('button', { name: 'set-app-origin' }));

    await waitFor(() => {
      expect(screen.getByTestId('preview-url')).toHaveTextContent('/preview/5173/app');
    });
  });
});
