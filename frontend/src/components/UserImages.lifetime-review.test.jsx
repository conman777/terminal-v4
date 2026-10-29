// Three real-component regressions. Mocked HTTP and the DOM file-input change
// seam do not prove a native chooser, clipboard, live server, or Blob durability.
import { createHash, webcrypto } from 'node:crypto';
import { Blob as NativeBlob } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { clearTokens, setAuthInitializing, setTokens, setUser } from '../utils/auth';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn(), uploadScreenshot: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
import { apiFetch } from '../utils/api';
import { V4UserImages } from './V4UserImages';
import { DesktopStatusBar } from './DesktopStatusBar';

const BYTES = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ8sAAAAASUVORK5CYII=', 'base64'));
const A = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: createHash('sha256').update('v4-image-v1\0image/png\0').update(BYTES).digest('hex'), mimeType: 'image/png', bytes: BYTES.length, name: 'current.png' };
const response = () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png', 'content-length': String(BYTES.length) }), blob: async () => new NativeBlob([BYTES], { type: 'image/png' }) });
const token = () => `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: 'gui-review-owner', exp: Math.floor(Date.now() / 1000) + 300 }))}.synthetic-signature`;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
function controller(sessionId, generation) {
  return {
    scopeKey: JSON.stringify(['gui-review-owner', window.location.origin + '/', 'home', sessionId]), generation,
    items: [{ localId: A.attachmentId, name: A.name, mimeType: A.mimeType, bytes: A.bytes, status: 'ready', error: '' }],
    admission: { state: 'allowed', reason: '' }, canAdd: true, canSend: true, error: '', isHydrating: false, isSaving: false,
    pendingPreviousSend: null, addFiles: vi.fn(async () => {}), removeImage: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}),
    checkPreviousSend: vi.fn(async () => {}), retryPreviousSend: vi.fn(async () => {}),
  };
}
const props = (sessionId, userImages, overrides = {}) => ({ sessionId, userImages, attachmentsEnabled: false, composerValue: '', composerAttachments: [],
  onComposerChange: vi.fn(), onComposerSubmit: vi.fn(), showTopRow: false, showComposerFooter: false, showAiSelector: false,
  showMicButtons: false, showAutocorrectToggle: false, ...overrides });
beforeEach(() => {
  clearTokens(true); localStorage.clear(); setAuthInitializing(false);
  setEnvironmentIdentity('gui-review-owner', window.location.origin); setActiveEnvironment(null); setTokens(token(), 'synthetic-refresh'); setUser({ id: 'gui-review-owner' });
  apiFetch.mockReset(); vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('IntersectionObserver', class { constructor(callback) { this.callback = callback; } observe(target) { this.callback([{ target, isIntersecting: true }]); } disconnect() {} });
  let count = 0; URL.createObjectURL = vi.fn(() => `blob:current-review-${++count}`); URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  setEnvironmentIdentity(null); setActiveEnvironment(null); clearTokens(true); localStorage.clear();
});

describe('owned image presentation lifetime review regressions', () => {
  it('does not let an old rejected read revoke the newer ready URL after same-key auth generation changes', async () => {
    let rejectOld;
    apiFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    apiFetch.mockResolvedValue(response());
    render(<V4UserImages sessionId="ss-same-image-key" attachments={[A]} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await act(async () => { setTokens(token(), 'synthetic-next-refresh'); await Promise.resolve(); });
    const current = await screen.findByRole('img', { name: 'Attached image 1: current.png' });
    const currentUrl = current.getAttribute('src');
    expect(apiFetch).toHaveBeenCalledTimes(2); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(currentUrl);
    await act(async () => { rejectOld(new TypeError('Synthetic obsolete read failure')); await Promise.resolve(); await Promise.resolve(); });
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(currentUrl);
    expect(screen.getByRole('img', { name: 'Attached image 1: current.png' })).toHaveAttribute('src', currentUrl);
    expect(screen.queryByText('Attached image unavailable.')).not.toBeInTheDocument();
  });

  it('rejects a chooser result opened for A after switching to B and accepts a later chooser opened for B', async () => {
    const imagesA = controller('ss-picker-a', 1), imagesB = controller('ss-picker-b', 2);
    const view = render(<DesktopStatusBar {...props('ss-picker-a', imagesA)} />);
    const input = screen.getByLabelText('Choose images'), click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    expect(click).toHaveBeenCalledTimes(1);
    view.rerender(<DesktopStatusBar {...props('ss-picker-b', imagesB)} />);
    const oldSelection = new File([BYTES], 'chosen-for-a.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(screen.getByLabelText('Choose images'), { target: { files: [oldSelection] } }); });
    expect(imagesA.addFiles).not.toHaveBeenCalled(); expect(imagesB.addFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    const currentSelection = new File([BYTES], 'chosen-for-b.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(screen.getByLabelText('Choose images'), { target: { files: [currentSelection] } }); });
    expect(imagesA.addFiles).not.toHaveBeenCalled();
    expect(imagesB.addFiles).toHaveBeenCalledExactlyOnceWith([currentSelection], { source: 'picker' });
  });

  it('submits the same unmodified owned raw text for Enter and the Send button when the DOM normalizes a lone CR', () => {
    const userImages = controller('ss-raw-enter', 1), onComposerSubmit = vi.fn(), raw = 'left\rright';
    render(<DesktopStatusBar {...props('ss-raw-enter', userImages, { composerValue: raw, onComposerSubmit })} />);
    const textarea = screen.getByRole('textbox', { name: 'Command composer' });
    expect(textarea.value).toBe('left\nright');
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(onComposerSubmit).toHaveBeenCalledExactlyOnceWith(raw); onComposerSubmit.mockClear();
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onComposerSubmit).toHaveBeenCalledExactlyOnceWith(raw);
  });
});
