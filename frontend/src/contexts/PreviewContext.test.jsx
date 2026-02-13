import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewProvider, usePreview } from './PreviewContext';
import { apiFetch } from '../utils/api';
import { getActivePortsInfo } from '../utils/previewUrl';

const PREVIEW_LOCAL_ONLY_KEY = 'terminal_preview_local_only';

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(async () => ({
    ok: false,
    json: async () => ({})
  }))
}));

vi.mock('../utils/previewUrl', () => ({
  extractPortFromUrl: (url) => {
    if (!url || typeof url !== 'string') return null;
    const pathMatch = url.match(/\/preview\/(\d+)/);
    if (pathMatch) return Number.parseInt(pathMatch[1], 10);
    const subdomainMatch = url.match(/preview-(\d+)\./);
    if (subdomainMatch) return Number.parseInt(subdomainMatch[1], 10);
    const hostPortMatch = url.match(/:(\d{1,5})(?:\/|$)/);
    if (hostPortMatch) return Number.parseInt(hostPortMatch[1], 10);
    return null;
  },
  getActivePortsInfo: vi.fn(async () => [])
}));

function PreviewProbe({ onChange }) {
  const preview = usePreview();
  useEffect(() => {
    onChange(preview);
  }, [onChange, preview]);
  return <div data-testid="preview-url">{preview.previewUrl || ''}</div>;
}

describe('PreviewContext auto URL handling', () => {
  const mockGetActivePortsInfo = vi.mocked(getActivePortsInfo);
  const mockApiFetch = vi.mocked(apiFetch);

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({})
    });
    mockGetActivePortsInfo.mockResolvedValue([]);
  });

  it('accepts auto-detected URLs even when listening snapshot is empty', async () => {
    let contextValue = null;
    render(
      <PreviewProvider>
        <PreviewProbe onChange={(value) => { contextValue = value; }} />
      </PreviewProvider>
    );

    await waitFor(() => {
      expect(contextValue).not.toBeNull();
    });

    act(() => {
      contextValue.handleUrlDetected('http://localhost:5173');
    });

    expect(screen.getByTestId('preview-url')).toHaveTextContent('http://localhost:5173');
  });

  it('triggers an immediate active-port refresh when auto URL is not in current listening set', async () => {
    let contextValue = null;
    mockGetActivePortsInfo.mockResolvedValue([]);

    render(
      <PreviewProvider>
        <PreviewProbe onChange={(value) => { contextValue = value; }} />
      </PreviewProvider>
    );

    await waitFor(() => {
      expect(mockGetActivePortsInfo).toHaveBeenCalledTimes(1);
      expect(contextValue).not.toBeNull();
    });

    act(() => {
      contextValue.handleUrlDetected('http://localhost:5173');
    });

    await waitFor(() => {
      expect(mockGetActivePortsInfo.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('keeps user-selected preview URL when that port is still listening', async () => {
    let contextValue = null;
    mockGetActivePortsInfo.mockResolvedValue([
      { port: 3000, listening: true },
      { port: 5173, listening: true }
    ]);

    render(
      <PreviewProvider>
        <PreviewProbe onChange={(value) => { contextValue = value; }} />
      </PreviewProvider>
    );

    await waitFor(() => {
      expect(contextValue).not.toBeNull();
    });

    act(() => {
      contextValue.handlePreviewUrlChange('/preview/3000/');
    });
    expect(screen.getByTestId('preview-url')).toHaveTextContent('/preview/3000/');

    act(() => {
      contextValue.handleUrlDetected('/preview/5173/');
    });
    expect(screen.getByTestId('preview-url')).toHaveTextContent('/preview/3000/');
  });

  it('persists preview local-only config from backend', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        localOnly: true
      })
    });

    render(
      <PreviewProvider>
        <PreviewProbe onChange={() => {}} />
      </PreviewProvider>
    );

    await waitFor(() => {
      expect(localStorage.getItem(PREVIEW_LOCAL_ONLY_KEY)).toBe('true');
    });
  });
});
