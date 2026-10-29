import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../utils/api', async original => ({ ...await original(), uploadScreenshot: (...args) => mocks.upload(...args) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const props = () => ({ sessionId: 'owned-live-policy', composerValue: 'Keep this image draft', onComposerSubmit: vi.fn(),
  onComposerAttachmentAdd: vi.fn(), attachmentsDisabledMessage: 'Attachments are disabled for this view.', showMicButtons: false });
async function pasteDelayedHtml() {
  let deliver;
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [], getData: () => '',
    items: [{ kind: 'string', type: 'text/html', getAsString(callback) { deliver = callback; } }] } });
  await waitFor(() => expect(deliver).toBeTypeOf('function'));
  return () => deliver(html);
}
beforeEach(() => { mocks.upload.mockReset(); setActiveEnvironment(null); });

describe('DesktopStatusBar live legacy image policy with real HTML inspection', () => {
  it.each(['composerDisabled', 'attachmentsEnabled'])('rechecks %s before starting transport and releases pending inspection on rejection', async policy => {
    mocks.upload.mockResolvedValue('/owned/should-not-upload.png');
    const p = props(), view = render(<DesktopStatusBar {...p} />);
    const deliver = await pasteDelayedHtml();
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    view.rerender(<DesktopStatusBar {...p} {...{ [policy]: policy === 'composerDisabled' }} />);
    await act(async () => deliver());
    expect([mocks.upload.mock.calls, p.onComposerAttachmentAdd.mock.calls, p.onComposerSubmit.mock.calls]).toEqual([[], [], []]);
    view.rerender(<DesktopStatusBar {...p} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('Keep this image draft');
  });

  it.each(['composerDisabled', 'attachmentsEnabled'])('rechecks %s before appending an in-flight upload and always settles its work', async policy => {
    const upload = deferred(); mocks.upload.mockReturnValue(upload.promise);
    const p = props(), view = render(<DesktopStatusBar {...p} />);
    const deliver = await pasteDelayedHtml();
    await act(async () => deliver());
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    view.rerender(<DesktopStatusBar {...p} {...{ [policy]: policy === 'composerDisabled' }} />);
    await act(async () => upload.resolve('/owned/rejected-completion.png'));
    expect([p.onComposerAttachmentAdd.mock.calls, p.onComposerSubmit.mock.calls]).toEqual([[], []]);
    view.rerender(<DesktopStatusBar {...p} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('Keep this image draft');
  });

  it('accepts a delayed HTML image while the current view stays enabled without submitting its prompt', async () => {
    mocks.upload.mockResolvedValue('/owned/accepted.png');
    const p = props(); render(<DesktopStatusBar {...p} />);
    const deliver = await pasteDelayedHtml();
    await act(async () => deliver());
    expect(p.onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'pasted-image.png', path: '/owned/accepted.png' }]]);
    expect(p.onComposerSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });
});
