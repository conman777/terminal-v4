// UNAPPLIED preview. Mocked authenticated HTTP + real typed hash, not a live
// server/browser decoder/IndexedDB/Blob durability/full user-row integration proof.
import { createHash, webcrypto } from 'node:crypto';
import { Blob as NativeBlob } from 'node:buffer';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../utils/api';
import { V4UserImages } from './V4UserImages';

const MIME = 'image/png', BYTES = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ8sAAAAASUVORK5CYII=', 'base64'));
const typedHash = bytes => createHash('sha256').update('v4-image-v1\0').update(MIME).update('\0').update(bytes).digest('hex');
const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: typedHash(BYTES), mimeType: MIME, bytes: BYTES.length, name: 'canonical.png' };
const B_BYTES = BYTES.slice(), B = { ...A, attachmentId: '22222222-2222-4222-8222-222222222222', artifactId: typedHash(B_BYTES), name: 'second.png' };
const response = (bytes = BYTES, mime = MIME) => ({ ok: true, headers: new Headers({ 'content-length': String(bytes.length), 'content-type': mime }), blob: async () => new NativeBlob([bytes], { type: mime }) });
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const alt = (index, name) => `Attached image ${index}: ${name}`;
const unavailable = () => screen.findByText('Attached image unavailable.');
beforeEach(() => {
  setEnvironmentIdentity('user-image-render-fixture', window.location.origin); setActiveEnvironment(null); apiFetch.mockReset();
  vi.stubGlobal('crypto', webcrypto);
  // Visibility is deterministic unit scheduling, not geometry/native-browser proof.
  vi.stubGlobal('IntersectionObserver', class { constructor(callback) { this.callback = callback; } observe(target) { this.callback([{ target, isIntersecting: true }]); } unobserve() {} disconnect() {} });
  let count = 0; URL.createObjectURL = vi.fn(() => `blob:owned-user-fixture-${++count}`); URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.unstubAllGlobals(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  setEnvironmentIdentity(null); setActiveEnvironment(null);
});

describe('new owned accepted-user image renderer', () => {
  it('fetches the exact authenticated content route and verifies the typed artifact hash before showing an image', async () => {
    apiFetch.mockResolvedValue(response()); render(<V4UserImages sessionId="ss-render-fixture" attachments={[A]} />);
    expect(await screen.findByRole('img', { name: alt(1, A.name) })).toHaveAttribute('src', 'blob:owned-user-fixture-1');
    expect(screen.getByText(A.name)).toBeVisible();
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(`/api/structured/sessions/ss-render-fixture/attachments/${A.attachmentId}/content`, { signal: expect.any(AbortSignal) });
    expect(A.artifactId).not.toBe(createHash('sha256').update(BYTES).digest('hex'));
  });

  it('verifies accepted image bytes without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    apiFetch.mockResolvedValue(response()); render(<V4UserImages sessionId="ss-render-http" attachments={[A]} />);
    expect(await screen.findByRole('img', { name: alt(1, A.name) })).toBeVisible();
  });

  it('keeps canonical descriptor order and repeated occurrences in the visible accepted image list', async () => {
    apiFetch.mockImplementation(async url => response(url.includes(B.attachmentId) ? B_BYTES : BYTES));
    render(<V4UserImages sessionId="ss-render-order" attachments={[A, B, A]} />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    expect(screen.getAllByRole('img').map(image => image.getAttribute('alt'))).toEqual([alt(1, A.name), alt(2, B.name), alt(3, A.name)]);
    expect(apiFetch.mock.calls.every(([url]) => /^\/api\/structured\/sessions\/ss-render-order\/attachments\/[a-f0-9-]+\/content$/.test(url))).toBe(true);
  });

  it('refuses malformed refs and paired environments without fetching a URI, path or attachment', async () => {
    const invalid = render(<V4UserImages sessionId="ss-render-invalid" attachments={[{ ...A, attachmentId: '../outside', uri: 'https://invalid.example/image.png' }]} />);
    await unavailable(); expect(apiFetch).not.toHaveBeenCalled(); invalid.unmount();
    setActiveEnvironment({ id: 'paired-fixture', capabilities: { agentExecute: true, transfer: true } });
    render(<V4UserImages sessionId="ss-render-paired" attachments={[A]} />);
    await unavailable(); expect(apiFetch).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a raw-bytes-only hash instead of accepting it as the typed V4 artifact identity', async () => {
    const rawHash = createHash('sha256').update(BYTES).digest('hex'); apiFetch.mockResolvedValue(response());
    render(<V4UserImages sessionId="ss-render-hash" attachments={[{ ...A, artifactId: rawHash }]} />);
    await unavailable(); expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('retains explicit unavailable states for HTTP, MIME and exact byte-count failures', async () => {
    for (const failure of [{ ok: false, status: 404 }, response(BYTES, 'text/html'), response(new Uint8Array([1, 2, 3]))]) {
      apiFetch.mockResolvedValue(failure); const view = render(<V4UserImages sessionId="ss-render-failure" attachments={[A]} />);
      await unavailable(); expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(URL.createObjectURL).not.toHaveBeenCalled(); view.unmount();
    }
  });

  it('ignores a late old-session body and revokes its current object URL and requests on unmount', async () => {
    let releaseOld;
    apiFetch.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    apiFetch.mockResolvedValue(response(B_BYTES));
    const view = render(<V4UserImages sessionId="ss-before" attachments={[A]} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const oldSignal = apiFetch.mock.calls[0][1].signal;
    view.rerender(<V4UserImages sessionId="ss-after" attachments={[B]} />);
    expect(await screen.findByRole('img', { name: alt(1, B.name) })).toHaveAttribute('src', 'blob:owned-user-fixture-1');
    const currentSignal = apiFetch.mock.calls.at(-1)[1].signal;
    await act(async () => { releaseOld(response()); await Promise.resolve(); });
    expect(screen.queryByRole('img', { name: alt(1, A.name) })).not.toBeInTheDocument(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    view.unmount(); expect(oldSignal.aborted).toBe(true); expect(currentSignal.aborted).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned-user-fixture-1');
  });
});
