import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { apiFetch, apiGet } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { subscribeEnvironment } from '../utils/remoteEnvironments';

// Map API health check reasons to user-friendly messages
const HEALTH_ERROR_MESSAGES = {
  no_api_key: 'No Groq API key configured',
  invalid_api_key: 'Groq API key is invalid',
  network_error: "Can't reach Groq API - check network",
  timeout: 'Groq API not responding',
  rate_limited: 'Rate limited - wait a moment',
  api_error: 'Groq API error - try again',
  unauthorized: 'Not logged in',
  whisper_unavailable: 'Local Whisper server not available',
  no_provider: 'No transcription provider available'
};

function stopStream(stream) {
  stream?.getTracks().forEach(track => {
    try { track.stop(); } catch { /* Release the remaining tracks as well. */ }
  });
}

function releaseMedia(attempt) {
  const recorder = attempt.recorder;
  attempt.recorder = null;
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch { /* Track release must also run when the recorder fails. */ }
  }
  stopStream(attempt.stream);
  attempt.stream = null;
  attempt.chunks = [];
}

export function useVoiceInput(onTranscribed, { provider, scopeKey, available = true } = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState(null);
  const [audioStream, setAudioStream] = useState(null);
  const attemptRef = useRef(null);
  const mountedRef = useRef(false);
  const isRecordingRef = useRef(false);

  const cleanup = useCallback(() => {
    const attempt = attemptRef.current;
    // Invalidate before stop(): some recorders dispatch their final events synchronously.
    attemptRef.current = null;
    isRecordingRef.current = false;
    if (attempt) {
      attempt.controller.abort();
      releaseMedia(attempt);
    }
  }, []);

  const resetState = useCallback(() => {
    setIsRecording(false);
    setIsChecking(false);
    setIsRequesting(false);
    setIsTranscribing(false);
    setAudioStream(null);
    setError(null);
  }, []);

  useLayoutEffect(() => {
    if (available) return;
    cleanup();
    setIsRecording(false);
    setIsChecking(false);
    setIsRequesting(false);
    setIsTranscribing(false);
    setAudioStream(null);
  }, [available, cleanup]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    resetState();
    const invalidate = () => { cleanup(); resetState(); };
    let authority = captureAuthScope();
    const stopAuth = subscribeAuth(() => {
      const next = captureAuthScope();
      if (isAuthScopeCurrent(authority) && authority.userId === next.userId) return;
      authority = next;
      invalidate();
    });
    const stopEnvironment = subscribeEnvironment(invalidate);
    return () => {
      mountedRef.current = false;
      stopAuth();
      stopEnvironment();
      cleanup();
    };
  }, [cleanup, resetState, provider, scopeKey]);

  useEffect(() => {
    if (error && available) {
      const timer = setTimeout(() => setError(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [error, available]);

  const startRecording = useCallback(async () => {
    if (!mountedRef.current || !available) return;
    cleanup();
    resetState();
    const attempt = { controller: new AbortController(), auth: captureAuthScope(), stream: null, recorder: null, chunks: [], stopRequested: false };
    attemptRef.current = attempt;
    const isCurrent = () => {
      if (attemptRef.current !== attempt || attempt.controller.signal.aborted) return false;
      if (isAuthScopeCurrent(attempt.auth)) return true;
      cleanup();
      resetState();
      return false;
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not available (HTTPS required)');
      return;
    }

    setIsChecking(true);
    let health;
    try {
      const url = provider ? `/api/transcribe/health?provider=${provider}` : '/api/transcribe/health';
      health = await apiGet(url, { signal: attempt.controller.signal });
    } catch {
      if (!isCurrent()) return;
      setIsChecking(false);
      setError("Can't reach server - check connection");
      return;
    }
    if (!isCurrent()) return;
    setIsChecking(false);
    if (!health?.available) {
      setError(HEALTH_ERROR_MESSAGES[health?.reason] || health?.message || 'API check failed');
      return;
    }

    setIsRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) {
        stopStream(stream);
        return;
      }
      attempt.stream = stream;
      setIsRequesting(false);
      setAudioStream(stream);
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/wav';
      const recorder = new MediaRecorder(stream, { mimeType });
      attempt.recorder = recorder;

      recorder.ondataavailable = event => {
        if (isCurrent() && event.data.size > 0) attempt.chunks.push(event.data);
      };
      recorder.onstop = async () => {
        if (!isCurrent() || attempt.recorder !== recorder) return;
        const audioBlob = new Blob(attempt.chunks, { type: mimeType });
        releaseMedia(attempt);
        isRecordingRef.current = false;
        setIsRecording(false);
        setAudioStream(null);
        if (!attempt.stopRequested) return;
        if (audioBlob.size < 100) {
          setIsTranscribing(false);
          setError('No audio recorded');
          return;
        }

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('file', audioBlob, `recording.${mimeType.split('/')[1]}`);
          const url = provider ? `/api/transcribe?provider=${provider}` : '/api/transcribe';
          const response = await apiFetch(url, {
            method: 'POST', body: formData, signal: attempt.controller.signal
          });
          if (!isCurrent()) return;
          const result = await response.json();
          if (!isCurrent()) return;
          if (!response.ok) throw new Error(result.error || 'Request failed');
          if (result.text) {
            await onTranscribed?.(result.text);
          } else if (result.message) {
            setError(result.message);
          } else if (result.error) {
            if (result.details?.includes('rate_limit') || result.details?.includes('429')) {
              setError('Rate limited - wait a moment');
            } else if (result.details?.includes('EAI_AGAIN') || result.details?.includes('ENOTFOUND')) {
              setError("Network error - can't connect");
            } else {
              setError(result.error);
            }
          }
        } catch (err) {
          if (!isCurrent()) return;
          if (err.message?.includes('fetch') || err.message?.includes('network')) {
            setError("Network error - can't connect");
          } else {
            setError(err.message || 'Transcription failed');
          }
        } finally {
          if (isCurrent()) setIsTranscribing(false);
        }
      };
      recorder.onerror = () => {
        if (!isCurrent()) return;
        cleanup();
        resetState();
        setError('Recording error occurred');
      };

      try {
        recorder.start(250);
        if (!isCurrent()) return;
        isRecordingRef.current = true;
        setIsRecording(true);
      } catch {
        if (!isCurrent()) return;
        cleanup();
        resetState();
        setError('Failed to start recording');
      }
    } catch (err) {
      if (!isCurrent()) return;
      cleanup();
      resetState();
      if (err.name === 'NotAllowedError') {
        setError('Microphone access denied');
      } else if (err.name === 'NotSupportedError') {
        setError('Microphone not supported (HTTPS required)');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found');
      } else if (err.name === 'AbortError') {
        setError('Recording was interrupted');
      } else {
        setError(`Could not start recording: ${err.message}`);
      }
    }
  }, [cleanup, resetState, onTranscribed, provider, available]);

  const stopRecording = useCallback(() => {
    const attempt = attemptRef.current;
    if (!mountedRef.current || !attempt) return;
    if (!attempt.recorder || attempt.recorder.state === 'inactive') {
      if (!attempt.stopRequested) { cleanup(); resetState(); }
      return;
    }
    attempt.stopRequested = true;
    setIsTranscribing(true);
    try {
      attempt.recorder.stop();
    } catch {
      cleanup();
      resetState();
      setError('Failed to stop recording');
    }
    isRecordingRef.current = false;
    setIsRecording(false);
  }, [cleanup, resetState]);

  const cancelRecording = useCallback(() => {
    cleanup();
    resetState();
  }, [cleanup, resetState]);

  const toggleRecording = useCallback(() => {
    if (isRecordingRef.current) stopRecording();
    else startRecording();
  }, [startRecording, stopRecording]);

  return {
    isRecording,
    isChecking,
    isRequesting,
    isTranscribing,
    error,
    audioStream,
    toggleRecording,
    startRecording,
    stopRecording,
    cancelRecording
  };
}
