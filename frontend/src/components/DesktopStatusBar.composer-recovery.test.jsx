import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { beginAuthChange } from '../utils/auth';
import { useState } from 'react';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), inspect: vi.fn(), correct: vi.fn() }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: true, toggleAutocorrect() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));
vi.mock('../utils/api', async original => ({ ...await original(), uploadScreenshot: mocks.upload }));
vi.mock('../utils/clipboardImage', () => ({ getImageFileFromDataTransfer: mocks.inspect }));
vi.mock('../utils/autocorrect', () => ({ getSpellChecker: async () => ({}), getAutocorrectSuggestion: mocks.correct }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = new File(['owned synthetic image'], 'owned.png', { type: 'image/png' });
const props = () => ({ sessionId: 'owned-A', composerValue: 'teh', onComposerChange: vi.fn(), onComposerSubmit: vi.fn(), onComposerAttachmentAdd: vi.fn(), showMicButtons: false });
const drop = () => fireEvent.drop(screen.getByRole('textbox', { name: 'Command composer' }).closest('form'), { dataTransfer: { types: ['Files'], files: [file] } });
function UploadComposer({ submit, interrupt = () => {} }) {
  const [text, setText] = useState('Inspect this screenshot');
  const [attachments, setAttachments] = useState([]);
  return <DesktopStatusBar sessionId="owned-A" composerValue={text} onComposerChange={setText} composerAttachments={attachments}
    onComposerAttachmentAdd={image => setAttachments(items => [...items, image])}
    onComposerSubmit={value => { submit({ text: value, attachments }); setText(''); setAttachments([]); }}
    isStreaming onInterrupt={interrupt} showMicButtons={false} />;
}
function chooseImage(container) {
  fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

beforeEach(() => { vi.clearAllMocks(); mocks.inspect.mockReset(); mocks.upload.mockReset(); setActiveEnvironment(null); mocks.inspect.mockResolvedValue(file); mocks.correct.mockReturnValue('the'); });

describe('DesktopStatusBar composition and upload ownership', () => {
  it('holds submission until all concurrent legacy image work finishes', async () => {
    const first = deferred(), second = deferred(), submit = vi.fn();
    mocks.upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<UploadComposer submit={submit} />);
    drop(); drop();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve('/owned/first.png'));
    expect(view.container.querySelector('.status-send-btn:not(:disabled)')).toBeNull();
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => second.resolve('/owned/second.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(submit.mock.calls).toEqual([[{ text: 'Inspect this screenshot', attachments: [
      { name: file.name, path: '/owned/first.png' }, { name: file.name, path: '/owned/second.png' },
    ] }]]);
  });

  it('leaves ordinary text paste editable while inspection finds no image', async () => {
    const inspection = deferred(), submit = vi.fn();
    mocks.inspect.mockReturnValueOnce(inspection.promise);
    const view = render(<UploadComposer submit={submit} />);
    const input = screen.getByRole('textbox');
    expect(fireEvent.paste(input, { clipboardData: { files: [], items: [], getData: () => 'ordinary text' } })).toBe(true);
    expect(input).toBeEnabled();
    expect(view.container.querySelector('.status-send-btn:not(:disabled)')).toBeNull();
    await act(async () => inspection.resolve(null));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(input).toHaveValue('Inspect this screenshot');
  });

  it.each(['picker', 'drop', 'paste'])('holds Send, Enter and form submission through %s inspection/upload while keeping Stop usable', async source => {
    const inspection = deferred(), upload = deferred(), submit = vi.fn(), interrupt = vi.fn();
    if (source !== 'picker') mocks.inspect.mockReturnValueOnce(inspection.promise);
    mocks.upload.mockReturnValueOnce(upload.promise);
    const view = render(<UploadComposer submit={submit} interrupt={interrupt} />);
    if (source === 'picker') chooseImage(view.container);
    else if (source === 'drop') drop();
    else fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [file], items: [], getData: () => '' } });
    const form = screen.getByRole('textbox').closest('form');
    expect(view.container.querySelector('.status-send-btn:not(:disabled)')).toBeNull();
    fireEvent.submit(form);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    if (source !== 'picker') await act(async () => inspection.resolve(file));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    expect(view.container.querySelector('.status-send-btn:not(:disabled)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(interrupt).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('Inspect this screenshot');
    await act(async () => upload.resolve('/owned/screenshot.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(submit.mock.calls).toEqual([[{ text: 'Inspect this screenshot', attachments: [{ name: file.name, path: '/owned/screenshot.png' }] }]]);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(view.container.querySelector('.status-composer-attachment-name')).toBeNull();
  });

  it('retains text and exposes a retryable upload failure before sending the completed attachment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.upload.mockRejectedValueOnce(new Error('Synthetic upload unavailable')).mockResolvedValueOnce('/owned/retry.png');
    const submit = vi.fn(), view = render(<UploadComposer submit={submit} />);
    chooseImage(view.container);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic upload unavailable');
    expect(screen.getByRole('textbox')).toHaveValue('Inspect this screenshot');
    expect(submit).not.toHaveBeenCalled();
    chooseImage(view.container);
    await screen.findByText(file.name);
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(submit.mock.calls).toEqual([[{ text: 'Inspect this screenshot', attachments: [{ name: file.name, path: '/owned/retry.png' }] }]]);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves composition confirmation untouched before autocorrect or slash selection: %j', async native => {
    const p = props(); render(<DesktopStatusBar {...p} composerValue="/hel" />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...native });
    fireEvent(input, event);
    expect([event.defaultPrevented, p.onComposerSubmit.mock.calls, p.onComposerChange.mock.calls]).toEqual([false, [], []]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onComposerSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not autocorrect a composing space and retains ordinary space correction', async () => {
    const p = props(); render(<DesktopStatusBar {...p} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    await act(async () => {}); input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: ' ', isComposing: true });
    expect([mocks.correct.mock.calls, p.onComposerChange.mock.calls]).toEqual([[], []]);
    fireEvent.keyDown(input, { key: ' ' });
    expect(p.onComposerChange).toHaveBeenCalledWith('the ');
  });

  it('honors composition lifecycle when the browser omits keyboard flags', () => {
    const p = props(); render(<DesktopStatusBar {...p} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onComposerSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onComposerSubmit.mock.calls).toEqual([['teh']]);
  });

  it.each(['session', 'ABA', 'environment', 'auth', 'unmount'])('discards a completed legacy upload after %s changes', async kind => {
    const upload = deferred(); mocks.upload.mockReturnValueOnce(upload.promise);
    const p = props(); const view = render(<DesktopStatusBar {...p} />); drop();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    if (kind === 'session' || kind === 'ABA') view.rerender(<DesktopStatusBar {...p} sessionId="owned-B" />);
    if (kind === 'ABA') view.rerender(<DesktopStatusBar {...p} />);
    if (kind === 'environment') act(() => setActiveEnvironment({ id: 'owned-other' }));
    if (kind === 'auth') act(() => beginAuthChange());
    if (kind === 'unmount') view.unmount();
    await act(async () => upload.resolve('/owned/for-A.png'));
    expect(p.onComposerAttachmentAdd).not.toHaveBeenCalled();
  });

  it('ignores stale file inspection before starting any upload', async () => {
    const inspection = deferred(); mocks.inspect.mockReturnValueOnce(inspection.promise);
    const p = props(); const view = render(<DesktopStatusBar {...p} />); drop();
    view.rerender(<DesktopStatusBar {...p} sessionId="owned-B" />);
    await act(async () => inspection.resolve(file));
    expect([mocks.upload.mock.calls, p.onComposerAttachmentAdd.mock.calls]).toEqual([[], []]);
  });

  it('keeps a same-scope failure retryable and accepts the next successful upload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.upload.mockRejectedValueOnce(new Error('Synthetic upload failed')).mockResolvedValueOnce('/owned/retry.png');
    const p = props(); render(<DesktopStatusBar {...p} />); drop();
    await screen.findByText('Synthetic upload failed'); drop();
    await waitFor(() => expect(p.onComposerAttachmentAdd.mock.calls).toEqual([[{ name: file.name, path: '/owned/retry.png' }]]));
  });

  it('does not publish an obsolete failure or release the next session upload spinner', async () => {
    const old = deferred(), current = deferred(); mocks.upload.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const p = props(); const view = render(<DesktopStatusBar {...p} />); drop();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    view.rerender(<DesktopStatusBar {...p} sessionId="owned-B" />); drop();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    await act(async () => old.reject(new Error('Obsolete upload failed')));
    expect([screen.queryByText('Obsolete upload failed'), screen.getByRole('textbox', { name: 'Command composer' }).disabled]).toEqual([null, true]);
    await act(async () => current.resolve('/owned/for-B.png'));
    expect(p.onComposerAttachmentAdd.mock.calls).toEqual([[{ name: file.name, path: '/owned/for-B.png' }]]);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBeEnabled();
  });
});
