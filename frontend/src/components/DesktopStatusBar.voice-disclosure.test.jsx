import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn() }));
const device = vi.hoisted(() => ({ mobile: true }));
vi.mock('../utils/api', async importOriginal => ({ ...await importOriginal(), apiGet: api.get, apiFetch: api.fetch }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: () => device.mobile }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: true, toggleAutocorrect: vi.fn() }) }));
vi.mock('./AudioWaveform', () => ({ AudioWaveform: () => null }));

import { DesktopStatusBar } from './DesktopStatusBar';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let trackStop, permission, transcription, recorderStop, lastRecorder;
class Recorder {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; lastRecorder = this; }
  start() { this.state = 'recording'; }
  stop() {
    recorderStop();
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'.repeat(256)]) });
    this.onstop?.();
  }
}
const props = overrides => ({ sessionId: 'session-a', compactInputOptions: true, composerValue: 'Unsent draft', onComposerChange: vi.fn(), ...overrides });
const openMenu = () => fireEvent.click(screen.getByLabelText('More composer actions'));
const start = async label => {
  fireEvent.click(screen.getByLabelText(label));
  await screen.findByLabelText('Stop recording');
};

beforeEach(() => {
  device.mobile = true;
  trackStop = vi.fn(); recorderStop = vi.fn(); permission = deferred(); transcription = deferred(); lastRecorder = null;
  vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => permission.promise) } });
  api.get.mockReset().mockResolvedValue({ available: true });
  api.fetch.mockReset().mockImplementation(() => transcription.promise);
});
afterEach(() => vi.unstubAllGlobals());

describe('compact composer voice disclosure', () => {
  it.each([
    ['Voice input (local Whisper)', 'outside'],
    ['Voice input (local Whisper)', 'Escape'],
    ['Voice input (Groq cloud)', 'outside'],
    ['Voice input (Groq cloud)', 'Escape']
  ])('stops %s on %s close and appends to the latest draft', async (label, close) => {
    const onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...props({ onComposerChange })} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start(label);
    view.rerender(<DesktopStatusBar {...props({ onComposerChange, composerValue: 'Edited draft' })} />);
    if (close === 'outside') fireEvent.pointerDown(document.body);
    else fireEvent.keyDown(screen.getByLabelText('More composer actions').closest('details'), { key: 'Escape' });
    await waitFor(() => expect(trackStop).toHaveBeenCalledTimes(1));
    expect(recorderStop).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('More composer actions').closest('details').open).toBe(false);
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'dictated words' }) }));
    expect(onComposerChange).toHaveBeenCalledWith('Edited draft dictated words');
  });

  it('releases a late permission result after closing the menu', async () => {
    render(<DesktopStatusBar {...props()} />);
    openMenu();
    fireEvent.click(screen.getByLabelText('Voice input (local Whisper)'));
    await screen.findByLabelText('Requesting microphone access');
    fireEvent.keyDown(screen.getByLabelText('More composer actions').closest('details'), { key: 'Escape' });
    await act(async () => permission.resolve({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorderStop).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Stop recording')).not.toBeInTheDocument();
  });

  it('releases late permission after switching sessions without changing the new draft', async () => {
    const onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...props({ onComposerChange })} />);
    openMenu();
    fireEvent.click(screen.getByLabelText('Voice input (Groq cloud)'));
    await screen.findByLabelText('Requesting microphone access');
    view.rerender(<DesktopStatusBar {...props({ sessionId: 'session-b', composerValue: 'New session draft', onComposerChange })} />);
    await act(async () => permission.resolve({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorderStop).not.toHaveBeenCalled();
    expect(onComposerChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('New session draft');
  });

  it('keeps direct dictation active when the menu closes', async () => {
    render(<DesktopStatusBar {...props()} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.getByLabelText('Stop recording')).toBeVisible();
    expect(trackStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Stop recording'));
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it('releases a recording when the disclosure unmounts', async () => {
    const view = render(<DesktopStatusBar {...props()} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (local Whisper)');
    view.unmount();
    expect(recorderStop).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('preserves the new session draft when a closed menu transcription resolves late', async () => {
    const onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...props({ onComposerChange })} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (Groq cloud)');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(1));
    const signal = api.fetch.mock.calls[0][1].signal;
    view.rerender(<DesktopStatusBar {...props({ sessionId: 'session-b', composerValue: 'New session draft', onComposerChange })} />);
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'stale transcript' }) }));
    expect(signal.aborted).toBe(true);
    expect(onComposerChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('New session draft');
  });

  it('surfaces transcription errors after the menu closes', async () => {
    render(<DesktopStatusBar {...props()} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (local Whisper)');
    fireEvent.pointerDown(document.body);
    await act(async () => transcription.resolve({ ok: false, json: async () => ({ error: 'Transcription unavailable' }) }));
    expect(await screen.findByText('Transcription unavailable', { selector: '[role="alert"]' })).toBeVisible();
  });

  it('surfaces recorder stop errors and releases the microphone on close', async () => {
    recorderStop.mockImplementation(() => { throw new Error('fixture stop failure'); });
    render(<DesktopStatusBar {...props()} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (local Whisper)');
    fireEvent.pointerDown(document.body);
    expect(await screen.findByText('Failed to stop recording', { selector: '[role="alert"]' })).toBeVisible();
    expect(trackStop).toHaveBeenCalledTimes(1);
  });
});

describe('composer submission during dictation', () => {
  function Composer({ sessionId = 'session-a', compactInputOptions = true, composerDisabled = false, onSubmit }) {
    const [drafts, setDrafts] = React.useState({ 'session-a': 'Unsent draft', 'session-b': 'New session draft' });
    return <DesktopStatusBar {...props({ sessionId, compactInputOptions, composerDisabled,
      composerValue: drafts[sessionId], onComposerChange: value => setDrafts(current => ({ ...current, [sessionId]: value })), onComposerSubmit: onSubmit })} />;
  }

  it.each(['Voice input (local Whisper)', 'Voice input (Groq cloud)'])('blocks Send and Enter until closed-menu %s settles, preserving edits', async label => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start(label);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(input, { target: { value: 'Edited draft' } });
    const send = screen.getByRole('button', { name: 'Send to terminal' });
    fireEvent.pointerDown(send);
    expect(send).toBeDisabled();
    expect(await screen.findByText('Transcribing voice input…')).toBeVisible();
    fireEvent.click(send);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'dictated words' }) }));
    await waitFor(() => expect(send).toBeEnabled());
    expect(input).toHaveValue('Edited draft dictated words');
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Edited draft dictated words');
  });

  it('blocks direct dictation during permission and supports cancellation', async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText('Start voice input'));
    await screen.findByLabelText('Requesting microphone access');
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(screen.getByText('Requesting microphone access…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    await act(async () => permission.resolve({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks direct dictation through transcription and sends only after the transcript is appended', async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    const send = screen.getByRole('button', { name: 'Send to terminal' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Stop recording'));
    expect(send).toBeDisabled();
    expect(screen.getByText('Transcribing voice input…')).toBeVisible();
    fireEvent.submit(screen.getByRole('textbox', { name: 'Command composer' }).closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'direct words' }) }));
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Unsent draft direct words');
  });

  it('cancels an in-flight transcription and ignores its late result', async () => {
    render(<Composer onSubmit={vi.fn()} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (local Whisper)');
    fireEvent.pointerDown(document.body);
    await screen.findByText('Transcribing voice input…');
    const signal = api.fetch.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'late transcript' }) }));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Unsent draft');
  });

  it('does not discard a transcript when the composer becomes disabled', async () => {
    const onSubmit = vi.fn();
    const view = render(<Composer onSubmit={onSubmit} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    fireEvent.click(screen.getByLabelText('Stop recording'));
    view.rerender(<Composer onSubmit={onSubmit} composerDisabled />);
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'dictated words' }) }));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Unsent draft dictated words');
  });

  it('does not block the new session and ignores late transcription', async () => {
    const onSubmit = vi.fn();
    const view = render(<Composer onSubmit={onSubmit} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (Groq cloud)');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(api.fetch).toHaveBeenCalledOnce());
    view.rerender(<Composer sessionId="session-b" onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'late transcript' }) }));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('New session draft');
  });

  it('blocks submission for desktop provider buttons too', async () => {
    device.mobile = false;
    const onSubmit = vi.fn();
    render(<Composer compactInputOptions={false} onSubmit={onSubmit} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (local Whisper)');
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(screen.getByLabelText('Voice input (Groq cloud)')).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Command composer' }).closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('allows submission after a transcription error without changing the draft', async () => {
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Voice input (Groq cloud)');
    fireEvent.pointerDown(document.body);
    await act(async () => transcription.resolve({ ok: false, json: async () => ({ error: 'Transcription unavailable' }) }));
    expect(await screen.findByText('Transcription unavailable', { selector: '[role="alert"]' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Unsent draft');
  });
});

describe('voice surface availability', () => {
  it.each(['Start voice input', 'Voice input (local Whisper)', 'Voice input (Groq cloud)'])('cancels %s on hide, reports the loss on return, and permits sending', async label => {
    const onSubmit = vi.fn();
    function Composer({ available }) {
      const [draft, setDraft] = React.useState('Unsent draft');
      return <DesktopStatusBar {...props({ voiceAvailable: available, composerValue: draft, onComposerChange: setDraft, onComposerSubmit: onSubmit })} />;
    }
    const view = render(<Composer available />);
    if (label !== 'Start voice input') openMenu();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start(label);
    view.rerender(<Composer available={false} />);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(api.fetch).not.toHaveBeenCalled();
    view.rerender(<Composer available />);
    expect(screen.getByRole('alert')).toHaveTextContent('Voice input was cancelled');
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(input, { target: { value: 'Typed after return' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Typed after return');
  });

  it('fences permission granted after hiding', async () => {
    const view = render(<DesktopStatusBar {...props({ voiceAvailable: true })} />);
    fireEvent.click(screen.getByLabelText('Start voice input'));
    await screen.findByLabelText('Requesting microphone access');
    view.rerender(<DesktopStatusBar {...props({ voiceAvailable: false })} />);
    await act(async () => permission.resolve({ getTracks: () => [{ stop: trackStop }] }));
    expect(trackStop).toHaveBeenCalledOnce();
    expect(recorderStop).not.toHaveBeenCalled();
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('fences recorder events already queued before hiding', async () => {
    const onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...props({ voiceAvailable: true, onComposerChange })} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    const data = lastRecorder.ondataavailable;
    const stopped = lastRecorder.onstop;
    view.rerender(<DesktopStatusBar {...props({ voiceAvailable: false, onComposerChange })} />);
    await act(async () => {
      data({ data: new Blob(['x'.repeat(256)]) });
      await stopped();
    });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(onComposerChange).not.toHaveBeenCalled();
  });

  it('keeps an active recording through a temporary composer lock', async () => {
    const view = render(<DesktopStatusBar {...props()} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    view.rerender(<DesktopStatusBar {...props({ composerDisabled: true })} />);
    expect(trackStop).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Stop recording')).toBeVisible();
    fireEvent.click(screen.getByLabelText('Stop recording'));
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'dictated words' }) }));
  });

  it('does not request permission when a health check resolves after hiding', async () => {
    const health = deferred();
    api.get.mockReturnValue(health.promise);
    const view = render(<DesktopStatusBar {...props({ voiceAvailable: true })} />);
    fireEvent.click(screen.getByLabelText('Start voice input'));
    await screen.findByText('Checking voice input…');
    view.rerender(<DesktopStatusBar {...props({ voiceAvailable: false })} />);
    await act(async () => health.resolve({ available: true }));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('retains a pre-existing voice error while hidden', async () => {
    vi.useFakeTimers();
    try {
      api.get.mockResolvedValue({ available: false, reason: 'no_provider' });
      const view = render(<DesktopStatusBar {...props({ voiceAvailable: true })} />);
      await act(async () => { fireEvent.click(screen.getByLabelText('Start voice input')); });
      expect(screen.getByRole('alert')).toHaveTextContent('No transcription provider available');
      view.rerender(<DesktopStatusBar {...props({ voiceAvailable: false })} />);
      act(() => vi.advanceTimersByTime(5000));
      view.rerender(<DesktopStatusBar {...props({ voiceAvailable: true })} />);
      expect(screen.getByRole('alert')).toHaveTextContent('No transcription provider available');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts transcription on hide and fences a late result', async () => {
    const onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...props({ voiceAvailable: true, onComposerChange })} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    fireEvent.click(screen.getByLabelText('Stop recording'));
    await waitFor(() => expect(api.fetch).toHaveBeenCalledOnce());
    const signal = api.fetch.mock.calls[0][1].signal;
    view.rerender(<DesktopStatusBar {...props({ voiceAvailable: false, onComposerChange })} />);
    await act(async () => transcription.resolve({ ok: true, json: async () => ({ text: 'late transcript' }) }));
    expect(signal.aborted).toBe(true);
    expect(onComposerChange).not.toHaveBeenCalled();
    view.rerender(<DesktopStatusBar {...props({ voiceAvailable: true, onComposerChange })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Voice input was cancelled');
  });

  it('reports cancellation in the original session after switching away and back', async () => {
    const view = render(<DesktopStatusBar {...props()} />);
    permission.resolve({ getTracks: () => [{ stop: trackStop }] });
    await start('Start voice input');
    view.rerender(<DesktopStatusBar {...props({ sessionId: 'session-b' })} />);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Voice input was cancelled/)).not.toBeInTheDocument();
    view.rerender(<DesktopStatusBar {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Voice input was cancelled');
  });
});
