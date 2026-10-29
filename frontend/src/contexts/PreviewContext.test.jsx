import { setActiveEnvironment, getEnvironmentStorage } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewProvider, usePreview } from './PreviewContext';
import { getActivePortsInfo } from '../utils/previewUrl';

vi.mock('../utils/previewUrl', async importOriginal => ({
  ...await importOriginal(),
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

function PreviewConsumer({ fileTarget }) {
  const { previewUrl, handlePreviewUrlChange } = usePreview();

  return (
    <div>
      <span data-testid="preview-url">{previewUrl || 'none'}</span>
      <button onClick={() => handlePreviewUrlChange(fileTarget)}>set-file-target</button>
      <button type="button" onClick={() => handlePreviewUrlChange('/preview/5173/app')}>
        set-valid-preview
      </button>
      <button type="button" onClick={() => handlePreviewUrlChange('http://localhost:5173/app')}>set-manual-url</button>
      <button type="button" onClick={() => handlePreviewUrlChange('http://localhost:3020/')}>
        set-app-origin
      </button>
    </div>
  );
}

describe('PreviewContext', () => {
  let originalWindow;

  beforeEach(() => {
    setActiveEnvironment(null);
    vi.clearAllMocks();
    getActivePortsInfo.mockResolvedValue([{ port: 5173, listening: true }, { port: 3020, listening: true }]);
    originalWindow = window;
    localStorage.clear();
  });

  afterEach(() => {
    setActiveEnvironment(null);
    vi.stubGlobal('window', originalWindow);
    localStorage.clear();
  });

  it.each([
    '/tmp/preview space # %.html',
    String.raw`C:\project space\index.html`,
    'file:///tmp/preview%20space/index.html',
  ])('preserves manually selected static file target %s', async fileTarget => {
    render(<PreviewProvider><PreviewConsumer fileTarget={fileTarget} /></PreviewProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'set-file-target' }));
    await waitFor(() => expect(screen.getByTestId('preview-url')).toHaveTextContent(fileTarget));
  });

  it.each([false, true])('accepts a raw loopback app on the home UI port only for paired=%s', paired => {
    if (paired) setActiveEnvironment({ id: 'paired-host' });
    const fileTarget = `${window.location.origin}/app`;
    render(<PreviewProvider><PreviewConsumer fileTarget={fileTarget} /></PreviewProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'set-file-target' }));
    expect(screen.getByTestId('preview-url')).toHaveTextContent(paired ? fileTarget : 'none');
  });

  it('rejects ordinary application route input', async () => {
    render(<PreviewProvider><PreviewConsumer fileTarget="/settings" /></PreviewProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'set-file-target' }));
    expect(screen.getByTestId('preview-url')).toHaveTextContent('none');
  });

  it('retains a manual preview URL when port discovery is empty or stale', async () => {
    getActivePortsInfo.mockResolvedValue([]);
    render(<PreviewProvider><PreviewConsumer /></PreviewProvider>);
    await waitFor(() => expect(getActivePortsInfo).toHaveBeenCalled());
    getActivePortsInfo.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'set-manual-url' }));
    await waitFor(() => expect(getActivePortsInfo).toHaveBeenCalled());
    expect(screen.getByTestId('preview-url')).toHaveTextContent('http://localhost:5173/app');
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
  it('uses remote preview preferences locally without requesting account settings or host preview configuration', async () => {
    setActiveEnvironment({id:'remote'});
    render(<PreviewProvider><PreviewConsumer /></PreviewProvider>);
    fireEvent.click(screen.getByRole('button',{name:'set-valid-preview'}));
    await waitFor(()=>expect(screen.getByTestId('preview-url')).toHaveTextContent('/preview/5173/app'));
    expect([apiFetch.mock.calls,getEnvironmentStorage().getItem('terminal_preview_prefer_path_based')]).toEqual([[],'true']);
  });

});
