import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInput } from './useVoiceInput';
import { clearTokens } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const { apiGetMock, apiPostMock, apiFetchMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn(), apiFetchMock: vi.fn() }));
vi.mock('../utils/api', () => ({ apiGet: apiGetMock, apiPost: apiPostMock, apiFetch: apiFetchMock }));
let recorder;
let getUserMedia;
let stopTrack;
class SyntheticRecorder {
  static isTypeSupported = () => true;
  constructor() { this.state = 'inactive'; recorder = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x'.repeat(256)], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}
beforeEach(() => {
  recorder = null;
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiFetchMock.mockReset().mockImplementation(async (url, options) => ({
    ok: true,
    json: () => apiPostMock(url, options.body)
  }));
  stopTrack = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', SyntheticRecorder);
});
afterEach(() => {
  setActiveEnvironment(null);
  vi.unstubAllGlobals();
});

describe('useVoiceInput transcription contract', () => {
  it('starts with available health and posts a file part before delivering text', async () => {
    apiGetMock.mockResolvedValue({ available: true, provider: 'groq', message: 'OK' });
    apiPostMock.mockResolvedValue({ text: 'Synthetic transcript', provider: 'groq' });
    const onTranscribed = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscribed, { provider: 'groq' }));
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.isRecording).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(apiGetMock.mock.calls[0][0]).toBe('/api/transcribe/health?provider=groq');
    act(() => result.current.stopRecording());
    await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith('Synthetic transcript'));
    const [url, form] = apiPostMock.mock.calls[0];
    expect(url).toBe('/api/transcribe?provider=groq');
    expect([...form.keys()]).toEqual(['file']);
    expect(form.get('file')).toMatchObject({ name: 'recording.webm', size: 256, type: 'audio/webm' });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorder.state).toBe('inactive');
  });

  it('does not request microphone access when the canonical health response is unavailable', async () => {
    apiGetMock.mockResolvedValue({ available: false, provider: 'groq', message: 'No Groq API key configured' });
    const { result } = renderHook(() => useVoiceInput(vi.fn()));
    await act(async () => { await result.current.startRecording(); });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No Groq API key configured');
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useVoiceInput lifecycle ownership', () => {
  let construct;
  let start;
  let flushStop;
  let onTranscribed;

  beforeEach(() => {
    flushStop = undefined;
    apiGetMock.mockResolvedValue({ available: true });
    apiPostMock.mockResolvedValue({ text: 'Synthetic transcript' });
    construct = vi.fn();
    start = vi.fn();
    onTranscribed = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class QueuedRecorder extends SyntheticRecorder {
      constructor(stream, options) {
        construct(stream, options);
        super();
      }
      start() { start(); super.start(); }
      stop() {
        this.state = 'inactive';
        const data = this.ondataavailable;
        const stopped = this.onstop;
        flushStop = async () => {
          data?.({ data: new Blob(['x'.repeat(256)], { type: 'audio/webm' }) });
          await stopped?.();
        };
      }
    }
    vi.stubGlobal('MediaRecorder', QueuedRecorder);
  });

  afterEach(() => vi.restoreAllMocks());

  it('stays busy between stopping and the asynchronous final recorder event', async () => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    act(() => result.current.stopRecording());
    expect({ recording: result.current.isRecording, transcribing: result.current.isTranscribing }).toEqual({ recording: false, transcribing: true });
    await act(async () => { await flushStop(); });
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Synthetic transcript');
    expect(result.current.isTranscribing).toBe(false);
  });

  it('cancels a stopped recorder before its final event without uploading', async () => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    act(() => { result.current.stopRecording(); result.current.cancelRecording(); });
    await act(async () => { await flushStop(); });
    expect(result.current.isTranscribing).toBe(false);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it('releases permission granted after unmount without constructing a recorder', async () => {
    const permission = deferred();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    getUserMedia.mockReturnValue(permission.promise);
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    let pending;
    await act(async () => { pending = result.current.startRecording(); });
    expect(result.current.isRequesting).toBe(true);
    unmount();
    await act(async () => { permission.resolve(stream); await pending; });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(construct).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('ignores a health response after unmount before requesting permission', async () => {
    const health = deferred();
    apiGetMock.mockReturnValue(health.promise);
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    let pending;
    act(() => { pending = result.current.startRecording(); });
    unmount();
    await act(async () => { health.resolve({ available: true }); await pending; });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each(['support', 'constructor', 'start'])('releases the stream immediately on %s failure', async failure => {
    if (failure === 'support') MediaRecorder.isTypeSupported = () => { throw new Error('Unsupported recorder'); };
    if (failure === 'constructor') construct.mockImplementation(() => { throw new Error('Constructor failed'); });
    if (failure === 'start') start.mockImplementation(() => { throw new Error('Start failed'); });
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    expect({ recording: result.current.isRecording, requesting: result.current.isRequesting, stream: result.current.audioStream }).toEqual({ recording: false, requesting: false, stream: null });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.error).toBeTruthy();
    expect(apiPostMock).not.toHaveBeenCalled();
    if (recorder) expect([recorder.onstop, recorder.ondataavailable, recorder.onerror]).toEqual([null, null, null]);
  });

  it('discards queued final audio on active unmount and detaches handlers', async () => {
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    unmount();
    await act(async () => { await flushStop(); });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(onTranscribed).not.toHaveBeenCalled();
    expect([recorder.onstop, recorder.ondataavailable, recorder.onerror]).toEqual([null, null, null]);
  });

  it('aborts an in-flight upload and ignores completion after unmount', async () => {
    const upload = deferred();
    apiPostMock.mockReturnValue(upload.promise);
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed, { provider: 'local' }));
    await act(async () => { await result.current.startRecording(); });
    let pending;
    await act(async () => { result.current.stopRecording(); pending = flushStop(); });
    expect(result.current.isTranscribing).toBe(true);
    const options = apiFetchMock.mock.calls[0]?.[1];
    unmount();
    await act(async () => { upload.resolve({ text: 'Stale transcript' }); await pending; });
    expect(onTranscribed).not.toHaveBeenCalled();
    expect(options.signal.aborted).toBe(true);
  });

  it('aborts a pending upload response and never reads its stale body', async () => {
    const response = deferred();
    const json = vi.fn().mockResolvedValue({ text: 'Stale response body' });
    apiFetchMock.mockReturnValue(response.promise);
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    let pending;
    await act(async () => { result.current.stopRecording(); pending = flushStop(); });
    const signal = apiFetchMock.mock.calls[0][1].signal;
    unmount();
    await act(async () => { response.resolve({ ok: true, json }); await pending; });
    expect(signal.aborted).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(onTranscribed).not.toHaveBeenCalled();
  });

  it('discards a stopped recording when unmounted before the queued stop event', async () => {
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    act(() => result.current.stopRecording());
    unmount();
    await act(async () => { await flushStop(); });
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it.each(['local', 'groq', undefined])('keeps deliberate Stop uploading once for provider %s', async provider => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed, { provider }));
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { result.current.stopRecording(); await flushStop(); });
    expect(apiPostMock).toHaveBeenCalledOnce();
    expect(apiPostMock.mock.calls[0][0]).toBe(provider ? `/api/transcribe?provider=${provider}` : '/api/transcribe');
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Synthetic transcript');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect({ recording: result.current.isRecording, transcribing: result.current.isTranscribing, stream: result.current.audioStream }).toEqual({ recording: false, transcribing: false, stream: null });
  });

  it('cancels pending permission on provider change', async () => {
    const permission = deferred();
    getUserMedia.mockReturnValue(permission.promise);
    const { result, rerender } = renderHook(({ provider }) => useVoiceInput(onTranscribed, { provider }), { initialProps: { provider: 'local' } });
    let pending;
    await act(async () => { pending = result.current.startRecording(); });
    rerender({ provider: 'groq' });
    await act(async () => { permission.resolve({ getTracks: () => [{ stop: stopTrack }] }); await pending; });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(construct).not.toHaveBeenCalled();
    expect(result.current.isRequesting).toBe(false);
  });

  it('preserves recording across callback-only rerenders used by existing callers', async () => {
    const replacement = vi.fn();
    const { result, rerender } = renderHook(({ callback }) => useVoiceInput(callback), { initialProps: { callback: onTranscribed } });
    await act(async () => { await result.current.startRecording(); });
    rerender({ callback: replacement });
    expect(result.current.isRecording).toBe(true);
    await act(async () => { result.current.stopRecording(); await flushStop(); });
    expect(apiPostMock).toHaveBeenCalledOnce();
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Synthetic transcript');
    expect(replacement).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(false);
  });

  it('releases late microphone permission when the conversation changes with the same provider', async () => {
    const permission = deferred();
    getUserMedia.mockReturnValue(permission.promise);
    const { result, rerender } = renderHook(({ scopeKey }) => useVoiceInput(onTranscribed, { provider: 'local', scopeKey }), { initialProps: { scopeKey: 'conversation-one' } });
    let pending;
    await act(async () => { pending = result.current.startRecording(); });
    rerender({ scopeKey: 'conversation-two' });
    await act(async () => { permission.resolve({ getTracks: () => [{ stop: stopTrack }] }); await pending; });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(construct).not.toHaveBeenCalled();
    expect(result.current.isRequesting).toBe(false);
  });

  it('aborts transcription and ignores its result after a same-provider conversation switch', async () => {
    const upload = deferred();
    apiPostMock.mockReturnValue(upload.promise);
    const { result, rerender } = renderHook(({ scopeKey }) => useVoiceInput(onTranscribed, { provider: 'groq', scopeKey }), { initialProps: { scopeKey: 'conversation-one' } });
    await act(async () => { await result.current.startRecording(); });
    let pending;
    await act(async () => { result.current.stopRecording(); pending = flushStop(); });
    const signal = apiFetchMock.mock.calls[0][1].signal;
    rerender({ scopeKey: 'conversation-two' });
    await act(async () => { upload.resolve({ text: 'Old conversation transcript' }); await pending; });
    expect(signal.aborted).toBe(true);
    expect(onTranscribed).not.toHaveBeenCalled();
    expect(result.current.isTranscribing).toBe(false);
  });

  it('rejects a late transcript after shared account storage changes before its notification', async () => {
    const upload = deferred();
    apiPostMock.mockReturnValue(upload.promise);
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    let pending;
    await act(async () => { result.current.stopRecording(); pending = flushStop(); });
    const signal = apiFetchMock.mock.calls[0][1].signal;
    localStorage.setItem('terminal_auth_session', 'synthetic-other-tab-session');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-other-owner' }));
    await act(async () => { upload.resolve({ text: 'Stale owner transcript' }); await pending; });
    expect(onTranscribed).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(result.current.isTranscribing).toBe(false);
  });

  it('retains a deliberate transcription through same-account token rotation', async () => {
    const upload = deferred();
    apiPostMock.mockReturnValue(upload.promise);
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    let pending;
    await act(async () => { result.current.stopRecording(); pending = flushStop(); });
    localStorage.setItem('terminal_access_token', 'synthetic-rotated-access');
    localStorage.setItem('terminal_refresh_token', 'synthetic-rotated-refresh');
    await act(async () => { upload.resolve({ text: 'Same account transcript' }); await pending; });
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Same account transcript');
  });

  it('does not let superseded permission stop the newer recording', async () => {
    const permission = deferred();
    const lateStop = vi.fn();
    getUserMedia.mockReturnValueOnce(permission.promise);
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    let pending;
    await act(async () => { pending = result.current.startRecording(); });
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { permission.resolve({ getTracks: () => [{ stop: lateStop }] }); await pending; });
    expect(lateStop).toHaveBeenCalledOnce();
    expect(stopTrack).not.toHaveBeenCalled();
    expect(construct).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(true);
  });

  it('still records after StrictMode effect cleanup and setup replay', async () => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed), { wrapper: React.StrictMode });
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { result.current.stopRecording(); await flushStop(); });
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Synthetic transcript');
  });

  it.each(['environment', 'auth'])('disposes active recording on %s change', async scope => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    act(() => {
      if (scope === 'environment') setActiveEnvironment({ id: 'synthetic-voice-scope' });
      else clearTokens(true);
    });
    await act(async () => { await flushStop(); });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
    expect(result.current.audioStream).toBe(null);
  });

  it('ignores a rejected stale upload without clearing a newer transcription', async () => {
    const first = deferred();
    const second = deferred();
    apiPostMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    let stale;
    await act(async () => { result.current.stopRecording(); stale = flushStop(); });
    await act(async () => { await result.current.startRecording(); });
    let current;
    await act(async () => { result.current.stopRecording(); current = flushStop(); });
    await act(async () => { first.reject(new Error('stale network failure')); await stale; });
    expect({ transcribing: result.current.isTranscribing, error: result.current.error }).toEqual({ transcribing: true, error: null });
    await act(async () => { second.resolve({ text: 'Current transcript' }); await current; });
    expect(onTranscribed).toHaveBeenCalledExactlyOnceWith('Current transcript');
    expect(result.current.isTranscribing).toBe(false);
  });

  it('discards final audio when a recorder error disposes the attempt', async () => {
    const { result } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    act(() => recorder.onerror(new Error('Synthetic recorder failure')));
    await act(async () => { await flushStop(); });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Recording error occurred');
    expect(result.current.isRecording).toBe(false);
  });

  it('releases every track even if one track throws while stopping', async () => {
    const otherTrack = vi.fn();
    stopTrack.mockImplementation(() => { throw new Error('Synthetic track failure'); });
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }, { stop: otherTrack }] });
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
    await act(async () => { await result.current.startRecording(); });
    unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(otherTrack).toHaveBeenCalledOnce();
  });

  it('clears the error expiry timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      apiGetMock.mockResolvedValue({ available: false, reason: 'no_provider' });
      const { result, unmount } = renderHook(() => useVoiceInput(onTranscribed));
      await act(async () => { await result.current.startRecording(); });
      expect(result.current.error).toBe('No transcription provider available');
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
