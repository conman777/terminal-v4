// UNAPPLIED preview. Real production StatusBar, injected presentation controller.
// No upload, native clipboard, IndexedDB, Blob durability, or parent integration proof.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';

vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
vi.mock('../utils/api', () => ({ uploadScreenshot: vi.fn(), apiFetch: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../utils/clipboardImage', () => ({ getImageFileFromDataTransfer: vi.fn() }));
import { uploadScreenshot, apiFetch } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';

const A = { localId: '11111111-1111-4111-8111-111111111111', name: 'same.png', mimeType: 'image/png', bytes: 67, status: 'ready', error: '', previewUrl: '' };
const B = { ...A, localId: '22222222-2222-4222-8222-222222222222', name: 'second.webp', mimeType: 'image/webp', bytes: 68 };
function controller(overrides = {}) {
  return {
    scopeKey: JSON.stringify(['gui-fixture-owner', window.location.origin + '/', 'home', 'ss-gui-fixture']), generation: 1,
    items: [A],
    admission: { state: 'allowed', reason: '' }, canAdd: true, canSend: true, error: '', isHydrating: false, isSaving: false,
    pendingPreviousSend: null, addFiles: vi.fn(async () => {}), removeImage: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}),
    checkPreviousSend: vi.fn(async () => {}), retryPreviousSend: vi.fn(async () => {}), ...overrides,
  };
}
function props(overrides = {}) {
  return {
    sessionId: 'ss-gui-fixture', composerValue: '', composerAttachments: [], attachmentsEnabled: false,
    onComposerChange: vi.fn(), onComposerSubmit: vi.fn(), onComposerAttachmentAdd: vi.fn(), onComposerAttachmentRemove: vi.fn(),
    showTopRow: false, showComposerFooter: false, showAiSelector: false, showMicButtons: false, showAutocorrectToggle: false,
    userImages: controller(), ...overrides,
  };
}
const send = () => screen.getByRole('button', { name: 'Send to terminal' });
const textbox = () => screen.getByRole('textbox', { name: 'Command composer' });
const transfer = files => ({ types: ['Files'], files, items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' });
beforeEach(() => { vi.clearAllMocks(); getImageFileFromDataTransfer.mockResolvedValue(null); });
afterEach(() => vi.restoreAllMocks());

describe('owned image controller presentation in the real shared StatusBar', () => {
  it.each([false, true])('announces a shared and caught upload error once in compact mode %s', async compactConversation => {
    const message = 'The upload receipt is invalid or expired.';
    const userImages = controller({ items: [{ ...A, status: 'error', error: 'upload_unconfirmed' }], canSend: false,
      retryUpload: vi.fn().mockRejectedValue(new Error(message)) });
    const view = render(<DesktopStatusBar {...props({ userImages, compactConversation, composerValue: 'Keep this draft' })} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry image upload same.png' })); });
    view.rerender(<DesktopStatusBar {...props({ userImages: { ...userImages, error: message }, compactConversation, composerValue: 'Keep this draft' })} />);
    expect(screen.getAllByText(message, { exact: true })).toHaveLength(1);
    expect(send()).toBeDisabled();
    expect(textbox()).toHaveValue('Keep this draft');
  });

  it('retains distinct shared and caught failures', async () => {
    const sharedError = 'The upload receipt is invalid or expired.';
    const actionError = 'Image removal could not be confirmed. Retry removal.';
    const userImages = controller({ items: [{ ...A, status: 'error' }], error: sharedError, canSend: false,
      removeImage: vi.fn().mockRejectedValue(new Error(actionError)) });
    render(<DesktopStatusBar {...props({ userImages })} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove image same.png' })); });
    expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual([sharedError, actionError]);
  });

  it('enables a ready image-only draft and submits the unchanged empty text once', () => {
    const onComposerSubmit = vi.fn(); render(<DesktopStatusBar {...props({ onComposerSubmit })} />);
    expect(send()).toBeEnabled(); fireEvent.click(send());
    expect(onComposerSubmit).toHaveBeenCalledExactlyOnceWith('');
    expect(uploadScreenshot).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('passes the ordered multiple picker files to the controller instead of the legacy path uploader', async () => {
    const userImages = controller({ items: [] }); render(<DesktopStatusBar {...props({ userImages })} />);
    const input = screen.getByLabelText('Choose images');
    expect(input).toHaveAttribute('type', 'file'); expect(input).toHaveAttribute('multiple');
    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp');
    const files = [new File(['a'], 'first.png', { type: 'image/png' }), new File(['b'], 'second.webp', { type: 'image/webp' })];
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await act(async () => { fireEvent.change(input, { target: { files } }); });
    expect(userImages.addFiles).toHaveBeenCalledExactlyOnceWith(files, { source: 'picker' });
    expect(uploadScreenshot).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('pastes actual image items and exact raw plaintext at the selection without inserting a path', async () => {
    const userImages = controller({ items: [] }), raw = '\ufeff A\u0085B\r\n ', onComposerChange = vi.fn();
    render(<DesktopStatusBar {...props({ userImages, composerValue: 'left RIGHT tail', onComposerChange })} />);
    textbox().setSelectionRange(5, 10);
    const files = [new File(['a'], 'paste.png', { type: 'image/png' })];
    const clipboardData = { ...transfer(files), getData: type => type === 'text/plain' ? raw : '' };
    await act(async () => { fireEvent.paste(textbox(), { clipboardData }); });
    expect(userImages.addFiles).toHaveBeenCalledExactlyOnceWith(files, { source: 'paste' });
    // The callback retains supplied CRLF bytes; HTML textarea .value itself
    // normalizes line endings, so it is not the raw persistence assertion.
    expect(onComposerChange).toHaveBeenCalledExactlyOnceWith('left ' + raw + ' tail');
    expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it('drops the complete ordered actual file batch through the same controller', async () => {
    const userImages = controller({ items: [] }); render(<DesktopStatusBar {...props({ userImages })} />);
    const files = [new File(['a'], 'one.png', { type: 'image/png' }), new File(['b'], 'two.gif', { type: 'image/gif' })];
    await act(async () => { fireEvent.drop(textbox().closest('form'), { dataTransfer: transfer(files) }); });
    expect(userImages.addFiles).toHaveBeenCalledExactlyOnceWith(files, { source: 'drop' });
    expect(uploadScreenshot).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('keeps false, unknown, and paired admission blocked without silently sending the text alone', async () => {
    for (const reason of ['This model does not accept images.', 'Image support is not confirmed for this model.', 'Images are available on your home server. Switch from the paired environment to attach images.']) {
      const userImages = controller({ admission: { state: 'blocked', reason }, canAdd: false, canSend: false });
      const onComposerSubmit = vi.fn(), view = render(<DesktopStatusBar {...props({ userImages, composerValue: 'Keep raw text', onComposerSubmit })} />);
      expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled(); expect(screen.getByText(reason)).toBeVisible(); expect(send()).toBeDisabled();
      const files = [new File(['a'], 'blocked.png', { type: 'image/png' })];
      await act(async () => {
        fireEvent.paste(textbox(), { clipboardData: transfer(files) });
        fireEvent.drop(textbox().closest('form'), { dataTransfer: transfer(files) }); fireEvent.click(send());
      });
      expect(userImages.addFiles).not.toHaveBeenCalled(); expect(onComposerSubmit).not.toHaveBeenCalled(); expect(textbox()).toHaveValue('Keep raw text');
      expect(uploadScreenshot).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled(); view.unmount();
    }
  });

  it('shows distinct saving, saved, uploading, failure and missing-byte states while disabling partial Send', () => {
    const states = [['saving', 'Saving image…'], ['saved', 'Saved on device'], ['uploading', 'Uploading…'], ['error', 'Image upload failed'], ['missing_bytes', 'Original image bytes unavailable']];
    for (const [status, label] of states) {
      const userImages = controller({ items: [{ ...A, status }], canSend: false });
      const view = render(<DesktopStatusBar {...props({ userImages, composerValue: 'Do not omit this image' })} />);
      expect(within(screen.getByRole('region', { name: 'Image attachments' })).getByText(label)).toBeVisible();
      expect(send()).toBeDisabled(); expect(textbox()).toBeEnabled(); view.unmount();
    }
  });

  it('removes and retries by local identity with duplicate names without submitting the ordinary draft', async () => {
    const failed = { ...B, name: A.name, status: 'error', error: 'Synthetic upload failure' };
    const userImages = controller({ items: [A, failed], canSend: false }), onComposerSubmit = vi.fn();
    render(<DesktopStatusBar {...props({ userImages, onComposerSubmit, composerValue: 'Keep my text' })} />);
    const region = screen.getByRole('region', { name: 'Image attachments' });
    await act(async () => {
      fireEvent.click(within(region).getAllByRole('button', { name: 'Remove image same.png' })[0]);
      fireEvent.click(within(region).getByRole('button', { name: 'Retry image upload same.png' }));
    });
    expect(userImages.removeImage).toHaveBeenCalledExactlyOnceWith(A.localId); expect(userImages.retryUpload).toHaveBeenCalledExactlyOnceWith(B.localId);
    expect(onComposerSubmit).not.toHaveBeenCalled(); expect(textbox()).toHaveValue('Keep my text'); expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it('offers explicit previous-send Check and Retry without replacing or submitting a newer draft', async () => {
    const userImages = controller({ canSend: false, pendingPreviousSend: { requestId: '44444444-4444-4444-8444-444444444444', status: 'unknown', body: { text: 'Frozen previous' } } });
    const onComposerSubmit = vi.fn(); render(<DesktopStatusBar {...props({ userImages, onComposerSubmit, composerValue: 'Newer raw draft\ufeff' })} />);
    expect(screen.getByText('Previous send outcome unknown')).toBeVisible(); expect(screen.getByText('Frozen previous')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check previous send' })); fireEvent.click(screen.getByRole('button', { name: 'Retry previous send' }));
    });
    expect(userImages.checkPreviousSend).toHaveBeenCalledExactlyOnceWith(); expect(userImages.retryPreviousSend).toHaveBeenCalledExactlyOnceWith();
    expect(onComposerSubmit).not.toHaveBeenCalled(); expect(textbox()).toHaveValue('Newer raw draft\ufeff'); expect(send()).toBeDisabled();
  });

  it('preserves healthy text-only Send with unknown image support and the existing disabled Add image guard', () => {
    const userImages = controller({ items: [], admission: { state: 'blocked', reason: 'Image support is not confirmed for this model.' }, canAdd: false, canSend: true });
    const onComposerSubmit = vi.fn(), raw = ' \ufeffText-only draft\u0085 ';
    render(<DesktopStatusBar {...props({ userImages, composerValue: raw, onComposerSubmit })} />);
    expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled(); expect(send()).toBeEnabled(); fireEvent.click(send());
    expect(onComposerSubmit).toHaveBeenCalledExactlyOnceWith(raw);
  });

  it('preserves the legacy filesystem screenshot path when no owned controller is supplied', async () => {
    const file = new File(['a'], 'legacy.png', { type: 'image/png' }), onComposerAttachmentAdd = vi.fn();
    getImageFileFromDataTransfer.mockResolvedValue(file); uploadScreenshot.mockResolvedValue('/synthetic/legacy.png');
    render(<DesktopStatusBar {...props({ userImages: undefined, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    await act(async () => { fireEvent.paste(textbox(), { clipboardData: transfer([file]) }); });
    await waitFor(() => expect(onComposerAttachmentAdd).toHaveBeenCalledExactlyOnceWith({ name: 'legacy.png', path: '/synthetic/legacy.png' }));
    expect(uploadScreenshot).toHaveBeenCalledExactlyOnceWith(file);
  });
});
