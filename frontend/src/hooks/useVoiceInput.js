import { useState, useRef, useCallback, useEffect } from 'react';
import { apiPost, apiGet } from '../utils/api';

// Map API health check reasons to user-friendly messages
const HEALTH_ERROR_MESSAGES = {
  no_api_key: 'No Groq API key configured',
  invalid_api_key: 'Groq API key is invalid',
  network_error: "Can't reach Groq API - check network",
  timeout: 'Groq API not responding',
  rate_limited: 'Rate limited - wait a moment',
  api_error: 'Groq API error - try again',
  unauthorized: 'Not logged in'
};

export function useVoiceInput(onTranscribed) {
  const [isRecording, setIsRecording] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const isRecordingRef = useRef(false); // Ref to avoid stale closures in toggle

  // Cleanup function - stops any existing recording and releases resources
  const cleanup = useCallback(() => {
    // Stop media recorder if active
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (e) {
        // Ignore errors during cleanup
      }
      mediaRecorderRef.current = null;
    }

    // Stop all audio tracks
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => track.stop());
      } catch (e) {
        // Ignore errors during cleanup
      }
      streamRef.current = null;
    }

    // Clear audio chunks
    audioChunksRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Clear error after 4 seconds (slightly longer for better readability)
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Pre-flight API health check
  const checkApiHealth = useCallback(async () => {
    try {
      const result = await apiGet('/api/transcribe/health');
      if (result.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        message: HEALTH_ERROR_MESSAGES[result.reason] || 'API check failed'
      };
    } catch (err) {
      return {
        ok: false,
        message: "Can't reach server - check connection"
      };
    }
  }, []);

  const startRecording = useCallback(async () => {
    // Cleanup any existing recording first
    cleanup();

    setError(null);
    isRecordingRef.current = false;
    setIsRecording(false);

    // Check if getUserMedia is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Microphone not available (HTTPS required)');
      return;
    }

    // Pre-flight check: verify API is available before recording
    setIsChecking(true);
    const healthCheck = await checkApiHealth();
    setIsChecking(false);

    if (!healthCheck.ok) {
      setError(healthCheck.message);
      return;
    }

    // Show requesting state while browser prompts for permission
    setIsRequesting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Permission granted, hide requesting state
      setIsRequesting(false);
      streamRef.current = stream;

      // Try webm first, fall back to other formats
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : 'audio/wav';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        // Skip if too small (likely no audio)
        if (audioBlob.size < 1000) {
          setError('No audio recorded');
          return;
        }

        // Send to backend for transcription
        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', audioBlob, `recording.${mimeType.split('/')[1]}`);

          const result = await apiPost('/api/transcribe', formData);

          if (result.text) {
            onTranscribed?.(result.text);
          } else if (result.message) {
            setError(result.message);
          } else if (result.error) {
            // Parse specific error types from transcription response
            if (result.details?.includes('rate_limit') || result.details?.includes('429')) {
              setError('Rate limited - wait a moment');
            } else if (result.details?.includes('EAI_AGAIN') || result.details?.includes('ENOTFOUND')) {
              setError("Network error - can't connect");
            } else {
              setError(result.error);
            }
          }
        } catch (err) {
          // Handle fetch errors with better messages
          if (err.message?.includes('fetch') || err.message?.includes('network')) {
            setError("Network error - can't connect");
          } else {
            setError(err.message || 'Transcription failed');
          }
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.onerror = (e) => {
        console.error('MediaRecorder error:', e);
        setError('Recording error occurred');
        cleanup();
        isRecordingRef.current = false;
        setIsRecording(false);
      };

      // Start recording
      try {
        mediaRecorder.start();
        isRecordingRef.current = true;
        setIsRecording(true);
      } catch (startErr) {
        console.error('Failed to start MediaRecorder:', startErr);
        setError('Failed to start recording');
        cleanup();
      }
    } catch (err) {
      setIsRequesting(false);
      console.error('Recording error:', err.name, err.message);

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
  }, [cleanup, checkApiHealth, onTranscribed]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error('Error stopping recorder:', e);
      }
    }
    isRecordingRef.current = false;
    setIsRecording(false);
  }, []);

  // Use ref to check recording state to avoid stale closure issues
  const toggleRecording = useCallback(() => {
    if (isRecordingRef.current) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [startRecording, stopRecording]);

  return {
    isRecording,
    isChecking,
    isRequesting,
    isTranscribing,
    error,
    toggleRecording,
    startRecording,
    stopRecording
  };
}
