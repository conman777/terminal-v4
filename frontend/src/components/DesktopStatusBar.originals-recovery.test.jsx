// PREPARE ONLY. Real StatusBar/presentation with an injected read-only view.
// DOM file-change tests do not prove OS chooser behavior or durable storage.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
vi.mock('../utils/api', () => ({ uploadScreenshot: vi.fn(), apiFetch: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../utils/clipboardImage', () => ({ getImageFileFromDataTransfer: vi.fn() }));
import { apiFetch, uploadScreenshot } from '../utils/api';
import { A, B } from '../test/userImagesJoinFixture';
import { presentation, statusBarProps, originalFile, OTHER_REQUEST, NEWER_TEXT } from '../test/userImagesOriginalsRecoveryFixture';
import { DesktopStatusBar } from './DesktopStatusBar';

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const previousRegion = () => screen.getByRole('region', { name: 'Previous send' });
const rowName = (slot, name) => `Choose original image ${slot + 1}: ${name}`;
function showRows() {
  const open = within(previousRegion()).queryByRole('button', { name: 'Choose original images' });
  if (open) fireEvent.click(open);
}
function openSlot(slot, name) {
  showRows(); fireEvent.click(within(previousRegion()).getByRole('button', { name: rowName(slot, name) }));
  const input = screen.getByLabelText('Choose original image file');
  expect(input).toHaveAttribute('type', 'file'); expect(input).not.toHaveAttribute('multiple');
  return input;
}
async function change(input, files) { await act(async () => { fireEvent.change(input, { target: { files } }); }); }
function noUnrelatedAction(images, props) {
  expect(images.addFiles).not.toHaveBeenCalled(); expect(images.retryUpload).not.toHaveBeenCalled(); expect(images.removeImage).not.toHaveBeenCalled();
  expect(images.checkPreviousSend).not.toHaveBeenCalled(); expect(images.retryPreviousSend).not.toHaveBeenCalled();
  expect(props.onComposerSubmit).not.toHaveBeenCalled(); expect(props.onComposerAttachmentAdd).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled(); expect(uploadScreenshot).not.toHaveBeenCalled();
}

describe('original recovery uses one explicit-purpose per-view chooser in the real StatusBar', () => {
  it('[OU01] displays numbered pin occurrences; choosing is available with blocked model admission and cannot Add/upload/send', async () => {
    const opened = []; vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () { opened.push({ node: this, connected: this.isConnected }); });
    const images = presentation(), props = statusBarProps(images); render(<DesktopStatusBar {...props} />);
    expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled(); showRows();
    const buttons = within(previousRegion()).getAllByRole('button', { name: /^Choose original image \d+:/ });
    expect(buttons.map(button => button.getAttribute('aria-label') || button.textContent)).toEqual([rowName(0, B.name), rowName(1, A.name), rowName(2, A.name)]);
    expect(within(previousRegion()).getAllByText(/image\/png/)).toHaveLength(3);
    expect(within(previousRegion()).getAllByText(/4 bytes/)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Save original images' })).toBeDisabled();
    const input = openSlot(0, B.name);
    expect(opened).toEqual([{ node: input, connected: true }]);
    const file = originalFile(B); await change(input, [file]);
    expect(opened).toEqual([{ node: input, connected: true }]);
    expect(images.selectOriginalImage).toHaveBeenCalledExactlyOnceWith(file, { requestId: images.pendingPreviousSend.requestId, slot: 0, originalsRevision: 1 });
    expect(images.saveOriginalImages).not.toHaveBeenCalled(); expect(input.value).toBe(''); noUnrelatedAction(images, props);
  });

  it('[OU02] permits the exact same File to be chosen twice for duplicate occurrences without a multi-file ordering guess', async () => {
    const images = presentation(), props = statusBarProps(images); render(<DesktopStatusBar {...props} />);
    const file = originalFile(A), first = openSlot(1, A.name); await change(first, [file]); expect(first.value).toBe('');
    const second = openSlot(2, A.name); expect(second).not.toBe(first); await change(second, [file]);
    expect(images.selectOriginalImage).toHaveBeenNthCalledWith(1, file, { requestId: images.pendingPreviousSend.requestId, slot: 1, originalsRevision: 1 });
    expect(images.selectOriginalImage).toHaveBeenNthCalledWith(2, file, { requestId: images.pendingPreviousSend.requestId, slot: 2, originalsRevision: 1 });
    expect(images.saveOriginalImages).not.toHaveBeenCalled(); noUnrelatedAction(images, props);
  });

  it('[OU03 slot ABA] a late slot-0 input cannot populate slot 1 or a new opening of slot 0', async () => {
    const images = presentation(), props = statusBarProps(images); render(<DesktopStatusBar {...props} />);
    const original = openSlot(0, B.name), middle = openSlot(1, A.name), current = openSlot(0, B.name);
    expect(middle).not.toBe(original); expect(current).not.toBe(original); expect(current).not.toBe(middle);
    await change(original, [originalFile(B)]); await change(middle, [originalFile(A)]);
    expect(images.selectOriginalImage).not.toHaveBeenCalled();
    const file = originalFile(B); await change(current, [file]);
    expect(images.selectOriginalImage).toHaveBeenCalledExactlyOnceWith(file, { requestId: images.pendingPreviousSend.requestId, slot: 0, originalsRevision: 1 });
    noUnrelatedAction(images, props);
  });

  it.each(['request', 'pinset', 'view', 'scope'])('[OU04] %s ABA rejects an old input even when the visible names and scope string return', async kind => {
    const images = presentation(), props = statusBarProps(images), view = render(<DesktopStatusBar {...props} />);
    const original = openSlot(0, B.name);
    const revision = kind === 'request' || kind === 'pinset' ? 3 : 1;
    const changed = { ...images, pendingPreviousSend: { ...images.pendingPreviousSend, originalsRevision: revision === 3 ? 2 : 1 } };
    if (kind === 'request') changed.pendingPreviousSend.requestId = OTHER_REQUEST;
    if (kind === 'view') changed.generation = 2;
    if (kind === 'scope') changed.scopeKey = JSON.stringify(['other-owner', window.location.origin + '/', 'home', props.sessionId]);
    view.rerender(<DesktopStatusBar {...statusBarProps(changed)} />);
    const returned = { ...images, generation: kind === 'view' || kind === 'scope' ? 3 : images.generation,
      pendingPreviousSend: { ...images.pendingPreviousSend, originalsRevision: revision } };
    view.rerender(<DesktopStatusBar {...statusBarProps(returned)} />);
    const current = openSlot(0, B.name); expect(current).not.toBe(original);
    await change(original, [originalFile(B)]); expect(images.selectOriginalImage).not.toHaveBeenCalled();
    const file = originalFile(B); await change(current, [file]);
    expect(images.selectOriginalImage).toHaveBeenCalledExactlyOnceWith(file, { requestId: images.pendingPreviousSend.requestId, slot: 0, originalsRevision: revision });
    noUnrelatedAction(images, props);
  });

  it('[OU05] multiple files or cancelled single-slot selection is rejected rather than truncated, matched by filename, or routed to Add', async () => {
    const images = presentation(), props = statusBarProps(images); render(<DesktopStatusBar {...props} />);
    await change(openSlot(0, B.name), []);
    await change(openSlot(0, B.name), [originalFile(B), originalFile(A)]);
    expect(images.selectOriginalImage).not.toHaveBeenCalled(); expect(images.saveOriginalImages).not.toHaveBeenCalled(); noUnrelatedAction(images, props);
  });

  it('[OU06] two simultaneous StatusBars have independent picker leases although choices are projected by their shared owner', async () => {
    const first = presentation(), second = { ...first, selectOriginalImage: vi.fn(async () => ({})) };
    const a = render(<DesktopStatusBar {...statusBarProps(first)} />), b = render(<DesktopStatusBar {...statusBarProps(second)} />);
    function openIn(container, slot, name) {
      const local = within(container), section = local.getByRole('region', { name: 'Previous send' });
      fireEvent.click(within(section).getByRole('button', { name: 'Choose original images' }));
      fireEvent.click(within(section).getByRole('button', { name: rowName(slot, name) }));
      return local.getByLabelText('Choose original image file');
    }
    const inputA = openIn(a.container, 0, B.name), inputB = openIn(b.container, 1, A.name);
    a.unmount(); await change(inputA, [originalFile(B)]);
    expect(first.selectOriginalImage).not.toHaveBeenCalled(); expect(second.selectOriginalImage).not.toHaveBeenCalled();
    const file = originalFile(A); await change(inputB, [file]);
    expect(second.selectOriginalImage).toHaveBeenCalledExactlyOnceWith(file, { requestId: second.pendingPreviousSend.requestId, slot: 1, originalsRevision: 1 });
    expect(apiFetch).not.toHaveBeenCalled(); expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it('[OU07] Save and retry-saving are separate explicit local actions; a failed attempt preserves the newer draft and selected state', async () => {
    const base = presentation(), selected = base.pendingPreviousSend.originals.map(slot => ({ ...slot, selected: true }));
    const images = presentation({ originals: selected, originalsCanSave: true }), props = statusBarProps(images);
    images.saveOriginalImages.mockRejectedValueOnce(new Error('Native quota')); const view = render(<DesktopStatusBar {...props} />); showRows();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save original images' })); });
    expect(images.saveOriginalImages).toHaveBeenCalledExactlyOnceWith({ requestId: images.pendingPreviousSend.requestId, originalsRevision: 1 });
    expect(screen.queryByText('Original images restored on this device. Check or retry the previous send.')).not.toBeInTheDocument();
    const failed = { ...images, pendingPreviousSend: { ...images.pendingPreviousSend, originalsState: 'error', originalsError: 'Native quota' } };
    view.rerender(<DesktopStatusBar {...statusBarProps(failed)} />);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(NEWER_TEXT.replace(/\r/g, '\n'));
    expect(images.saveOriginalImages).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry saving originals' })); });
    expect(images.saveOriginalImages).toHaveBeenCalledTimes(2); noUnrelatedAction(images, props);
  });

  it('[OU08] restored publication alone cannot run Check/Retry and still keeps them as separate explicit actions', async () => {
    const images = presentation({ status: 'unknown', originals: [], originalsState: 'restored', originalsCanSave: false });
    const props = statusBarProps(images); render(<DesktopStatusBar {...props} />);
    expect(screen.getByText('Original images restored on this device. Check or retry the previous send.')).toBeVisible();
    noUnrelatedAction(images, props);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check previous send' })); });
    expect(images.checkPreviousSend).toHaveBeenCalledExactlyOnceWith(); expect(images.retryPreviousSend).not.toHaveBeenCalled();
    expect(images.saveOriginalImages).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled(); expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it('[OU09 purpose] Add and restore openings cannot consume each other\'s late file results', async () => {
    const initial = presentation({}, { pendingPreviousSend: null, canAdd: true, admission: { state: 'allowed', reason: '' } });
    const props = statusBarProps(initial), view = render(<DesktopStatusBar {...props} />);
    const addInput = screen.getByLabelText('Choose images'); fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    view.rerender(<DesktopStatusBar {...statusBarProps({ ...initial, canAdd: false, pendingPreviousSend: presentation().pendingPreviousSend })} />);
    const restoreInput = openSlot(0, B.name); expect(restoreInput).not.toBe(addInput);
    await change(addInput, [originalFile(A)]); expect(initial.addFiles).not.toHaveBeenCalled(); expect(initial.selectOriginalImage).not.toHaveBeenCalled();
    const next = { ...initial, pendingPreviousSend: null }; view.rerender(<DesktopStatusBar {...statusBarProps(next)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add image' })); const currentAddInput = screen.getByLabelText('Choose images');
    expect(currentAddInput).not.toBe(restoreInput);
    await change(restoreInput, [originalFile(B)]); expect(initial.selectOriginalImage).not.toHaveBeenCalled(); expect(initial.addFiles).not.toHaveBeenCalled();
    const file = originalFile(A); await change(currentAddInput, [file]);
    expect(initial.addFiles).toHaveBeenCalledExactlyOnceWith([file], { source: 'picker' });
    expect(initial.saveOriginalImages).not.toHaveBeenCalled(); expect(apiFetch).not.toHaveBeenCalled(); expect(uploadScreenshot).not.toHaveBeenCalled();
  });
});
