import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPip } from './PreviewPip';
import { apiFetch } from '../utils/api';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
let serial;
beforeEach(() => {
  localStorage.clear(); clearTokens(true); setTokens('owner-access', 'owner-refresh'); setUser({ id: 'preview-owner', username: 'fixture' }); setActiveEnvironment(null); serial = 0;
  apiFetch.mockReset().mockImplementation(async (_path, options) => ({ ok: true, json: async () => ({ targetPath: options.body.targetPath, previewToken: `ticket-${++serial}`, expiresAt: 2000000000 }) }));
});
const props = { url: '/preview/4173/app', onClose: vi.fn(), onDock: vi.fn() };

describe('PreviewPip resource authorization', () => {
  it('keeps header actions clickable without starting a window drag', () => {
    const onPositionChange = vi.fn();
    const { container } = render(<PreviewPip {...props} onPositionChange={onPositionChange} />);
    fireEvent.mouseDown(screen.getByTitle('Dock to side panel'), { clientX: 200, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 220, clientY: 120 });
    expect(container.querySelector('.preview-pip')).not.toHaveClass('dragging');
    expect(onPositionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Dock to side panel'));
    expect(props.onDock).toHaveBeenCalledOnce();
  });

  it('loads a read-only resource grant in an isolated frame and obtains a fresh grant on refresh', async () => {
    const { container } = render(<PreviewPip {...props} />);
    const frame = container.querySelector('iframe');
    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('sandbox').split(' ')).not.toContain('allow-same-origin');
    await waitFor(() => expect(new URL(frame.src).searchParams.get('previewToken')).toBe('ticket-1'));
    expect(new URL(frame.src).searchParams.has('token')).toBe(false);
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(new URL(frame.src).searchParams.get('previewToken')).toBe('ticket-2'));
    expect(apiFetch).toHaveBeenCalledWith('/api/preview/resource-auth', expect.objectContaining({ home: true, body: { targetPath: '/preview/4173/app' } }));
  });

  it('brokers validated metrics from its currently authorized iframe', async () => {
    const { container } = render(<PreviewPip {...props} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('ticket-1'));
    await act(async () => {});
    const frame = container.querySelector('iframe');
    const metrics = [{ type: 'runtimeMetrics', timestamp: 123, data: { fps: 60 } }];
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: { type: 'preview-performance', port: 4173, documentUrl: frame.src, documentGrant: new URL(frame.src).searchParams.get('previewToken'), metrics } }));
    expect(apiFetch).toHaveBeenCalledWith('/api/preview/4173/performance', expect.objectContaining({ home: true, method: 'POST', body: { metrics } }));
  });

  it('remints when a minimized preview is expanded instead of reusing an expired URL', async () => {
    const { container } = render(<PreviewPip {...props} />);
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('ticket-1'));
    fireEvent.click(screen.getByTitle('Minimize'));
    expect(container.querySelector('iframe')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Expand'));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('ticket-2'));
  });

  it('shows authorization failure without navigating the frame and permits a retry', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Preview denied' }) });
    const { container } = render(<PreviewPip {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview denied');
    expect(container.querySelector('iframe').getAttribute('src')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('ticket-1'));
  });

  it('does not publish a pending grant after an account change', async () => {
    let finishPrevious;
    apiFetch.mockImplementationOnce(() => new Promise(resolve => { finishPrevious = resolve; }));
    const { container } = render(<PreviewPip {...props} />);
    await waitFor(() => expect(finishPrevious).toBeTypeOf('function'));
    act(() => setTokens('new-owner-access', 'new-owner-refresh'));
    await waitFor(() => expect(container.querySelector('iframe')?.src).toContain('ticket-1'));
    await act(async () => finishPrevious({ ok: true, json: async () => ({ targetPath: '/preview/4173/app', previewToken: 'old-owner-ticket', expiresAt: 2000000000 }) }));
    expect(container.querySelector('iframe').src).toContain('ticket-1');
    expect(container.querySelector('iframe').src).not.toContain('old-owner-ticket');
  });
});
