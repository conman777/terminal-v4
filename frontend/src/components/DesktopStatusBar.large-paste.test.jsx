import { useState, useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setUser } from '../utils/auth';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../utils/api', () => ({ uploadAttachment: upload, uploadScreenshot: vi.fn() }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
vi.mock('../utils/clipboardImage', () => ({ getImageFileFromDataTransfer: vi.fn(async () => null) }));

function draftStore(initial) {
  let snapshot = { text: initial, revision: 0, error: '' };
  let failWrites = false;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    failWrites() { failWrites = true; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setText(value) {
      const text = typeof value === 'function' ? value(snapshot.text) : value;
      snapshot = { text, revision: snapshot.revision + 1, error: failWrites ? 'Synthetic storage failure' : '' };
      listeners.forEach(listener => listener());
    },
  };
}

function Harness({ store, sessionId = 'large-paste', initialAttachments = [], compactInputOptions = false, waitForAttachmentPersistence = async () => true }) {
  const draft = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [attachments, setAttachments] = useState(initialAttachments);
  return <DesktopStatusBar sessionId={sessionId} compactInputOptions={compactInputOptions} composerValue={draft.text} composerDraftStore={store}
    onComposerChange={store.setText} onComposerSubmit={() => {}} composerAttachments={attachments} attachmentsEnabled allowAnyFile
    onComposerAttachmentAdd={item => setAttachments(previous => [...previous, item])}
    onComposerAttachmentRemove={path => setAttachments(previous => previous.filter(item => item.path !== path))}
    waitForAttachmentPersistence={waitForAttachmentPersistence} showTopRow={false} showAiSelector={false} showMicButtons={false} />;
}

const large = 'x'.repeat(32 * 1024);
const input = () => screen.getByRole('textbox', { name: 'Command composer' });
function paste(text) { return fireEvent.paste(input(), { clipboardData: { files: [], items: [], types: ['text/plain'], getData: type => type === 'text/plain' ? text : '' } }); }

beforeEach(() => {
  Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key));
  upload.mockReset();
});

describe('large text paste', () => {
  it('keeps the exact paste in the draft until the uploaded file is saved, then replaces the selection', async () => {
    let finishUpload;
    upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    const store = draftStore('left SELECT right');
    render(<Harness store={store} />);
    input().setSelectionRange(5, 11);
    await act(async () => { paste(large); });
    expect(store.getSnapshot().text).toBe(`left ${large} right`);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(input()).toBeEnabled();
    expect(upload.mock.calls[0][0]).toMatchObject({ name: 'pasted-text.txt', size: 32 * 1024 });
    await act(async () => { finishUpload('/fixture/pasted-text.txt'); });
    await waitFor(() => expect(store.getSnapshot().text).toBe('left  right'));
    expect(screen.getByText('pasted-text.txt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });

  it('keeps pasted text when uploading fails', async () => {
    upload.mockRejectedValue(new Error('Synthetic upload failure'));
    const store = draftStore('');
    render(<Harness store={store} />);
    await act(async () => { paste(large); });
    expect(store.getSnapshot().text).toBe(large);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue with current files' })).toBeVisible();
  });

  it('does not erase newer typing when the upload completes', async () => {
    let finishUpload;
    upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    const store = draftStore('');
    render(<Harness store={store} />);
    await act(async () => { paste(large); });
    fireEvent.change(input(), { target: { value: `${large} newer typing` } });
    await act(async () => { finishUpload('/fixture/pasted-text.txt'); });
    expect(store.getSnapshot().text).toBe(`${large} newer typing`);
    expect(screen.getByText('pasted-text.txt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue with current files' })).toBeVisible();
  });

  it('does not start an upload when the pasted draft cannot be saved', async () => {
    const store = draftStore('');
    store.failWrites();
    render(<Harness store={store} />);
    await act(async () => { paste(large); });
    expect(store.getSnapshot().text).toBe(large);
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/keep this tab open/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
  });

  it('keeps the pasted text and asks for review if the attachment cannot be saved', async () => {
    upload.mockResolvedValue('/fixture/pasted-text.txt');
    const store = draftStore('');
    render(<Harness store={store} waitForAttachmentPersistence={async () => false} />);
    await act(async () => { paste(large); });
    expect(store.getSnapshot().text).toBe(large);
    expect(screen.getByText('pasted-text.txt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue with current files' })).toBeVisible();
  });

  it('keeps an oversized paste in the tab when no authenticated owner is available', async () => {
    setUser(null);
    const store = getComposerDraftStore('large-paste-storage-limit');
    store.setText('');
    render(<Harness store={store} sessionId="large-paste-storage-limit" />);
    const oversized = 'x'.repeat(1_000_000);
    await act(async () => { paste(oversized); });
    expect(store.getSnapshot().text).toBe(oversized);
    expect(store.getSnapshot().error).toMatch(/could not be saved/i);
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue with current files' })).toBeVisible();
  });

  it('does not change either draft after switching sessions during upload', async () => {
    let finishUpload;
    upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    const first = draftStore(''), second = draftStore('Second session');
    const view = render(<Harness store={first} sessionId="first-paste" />);
    await act(async () => { paste(large); });
    view.rerender(<Harness store={second} sessionId="second-paste" />);
    await act(async () => { finishUpload('/fixture/pasted-text.txt'); });
    expect(first.getSnapshot().text).toBe(large);
    expect(second.getSnapshot().text).toBe('Second session');
    expect(screen.queryByText('pasted-text.txt')).not.toBeInTheDocument();
  });

  it('counts UTF-8 bytes and uses a distinct filename for another paste', async () => {
    upload.mockResolvedValue('/fixture/pasted-text-2.txt');
    const store = draftStore('');
    render(<Harness store={store} initialAttachments={[{ name: 'PASTED-TEXT.TXT', path: '/fixture/existing' }]} />);
    await act(async () => { paste('界'.repeat(11000)); });
    expect(upload.mock.calls[0][0]).toMatchObject({ name: 'pasted-text-2.txt', size: 33000 });
    expect(store.getSnapshot().text).toBe('');
    expect(screen.getByText('pasted-text-2.txt')).toBeVisible();
  });

  it('leaves malformed Unicode as ordinary text instead of replacing its bytes', () => {
    const store = draftStore('');
    render(<Harness store={store} />);
    expect(paste(`${large}\ud800`)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('honors the platform paste-as-text shortcut without starting an upload', async () => {
    const store = draftStore('');
    render(<Harness store={store} />);
    fireEvent.keyDown(input(), { key: 'v', shiftKey: true, metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform) });
    let allowed;
    await act(async () => { allowed = paste(large); });
    expect(allowed).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('offers a one-time paste-as-text action on mobile', async () => {
    upload.mockResolvedValue('/fixture/pasted-text.txt');
    const store = draftStore('');
    render(<Harness store={store} compactInputOptions />);
    fireEvent.click(screen.getByLabelText('More composer actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste next as text' }));
    expect(screen.getByText(/next paste will stay as text/i)).toBeVisible();
    let allowed;
    await act(async () => { allowed = paste(large); });
    expect(allowed).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByText(/next paste will stay as text/i)).not.toBeInTheDocument();
    await act(async () => { paste(large); });
    expect(upload).toHaveBeenCalledOnce();
  });

  it('lets a mobile user cancel the next-paste choice', async () => {
    upload.mockResolvedValue('/fixture/pasted-text.txt');
    const store = draftStore('');
    render(<Harness store={store} compactInputOptions />);
    fireEvent.click(screen.getByLabelText('More composer actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste next as text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { paste(large); });
    expect(upload).toHaveBeenCalledOnce();
  });
});
