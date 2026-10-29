import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../utils/api';
import { V4ToolImages } from './V4ToolImages';
const artifact = { type: 'v4_image', artifactId: 'a'.repeat(64), mimeType: 'image/png' };
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
describe('owned V4 tool images', () => {
  beforeEach(() => { setActiveEnvironment(null); apiFetch.mockReset(); URL.createObjectURL = vi.fn(() => 'blob:fixture-owned'); URL.revokeObjectURL = vi.fn(); });
  afterEach(() => { setActiveEnvironment(null); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; });
  it('fetches only the authenticated session artifact route and revokes its object URL on unmount', async () => {
    apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) });
    const { unmount } = render(<V4ToolImages sessionId="ss-fixture" content={[{ type: 'text', text: 'Result' }, artifact]} />);
    expect(await screen.findByRole('img', { name: 'Tool image 1' })).toHaveAttribute('src', 'blob:fixture-owned');
    expect(apiFetch).toHaveBeenCalledWith('/api/structured/sessions/ss-fixture/artifacts/' + artifact.artifactId + '/png', { signal: expect.any(AbortSignal) });
    const signal = apiFetch.mock.calls[0][1].signal;
    unmount(); expect(signal.aborted).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-owned');
  });
  it('does not fetch arbitrary URI refs, invalid hashes, or unsupported MIME types', async () => {
    render(<V4ToolImages sessionId="ss-fixture" content={[{ ...artifact, artifactId: '../elsewhere', uri: 'https://example.test/private' }, { ...artifact, mimeType: 'image/svg+xml' }]} />);
    expect(await screen.findAllByText('Tool image unavailable.')).toHaveLength(2);
    expect(apiFetch).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it.each(['not-found', 'wrong-type', 'too-large'])('shows an explicit unavailable state for %s artifacts', async failure => {
    apiFetch.mockResolvedValue(failure === 'not-found' ? { ok: false, status: 404 } : { ok: true, blob: async () => new Blob([failure === 'too-large' ? new Uint8Array(8 * 1024 * 1024 + 1) : 'fixture'], { type: failure === 'wrong-type' ? 'text/html' : 'image/png' }) });
    render(<V4ToolImages sessionId="ss-fixture" content={[artifact]} />);
    expect(await screen.findByText('Tool image unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('ignores a late image response after switching session and never exposes the old owner image', async () => {
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    apiFetch.mockResolvedValue({ ok: false, status: 404 });
    const { rerender } = render(<V4ToolImages sessionId="ss-before" content={[artifact]} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    rerender(<V4ToolImages sessionId="ss-after" content={[artifact]} />);
    await act(async () => { resolve({ ok: true, blob: async () => new Blob(['old fixture'], { type: 'image/png' }) }); });
    expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('removes the current object URL when the environment scope is revoked', async () => {
    apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) });
    render(<V4ToolImages sessionId="ss-fixture" content={[artifact]} />);
    await screen.findByRole('img');
    act(() => setActiveEnvironment({ id: 'different-host' }));
    expect(await screen.findByText('Tool image unavailable.')).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-owned');
  });
});
