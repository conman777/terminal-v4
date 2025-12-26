import { useState, useRef, useCallback, useEffect } from 'react';
import { apiPost } from '../utils/api';

export function useVoiceInput(onTranscribed) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Clear error after 3 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const startRecording = useCallback(async () => {
    setError(null);

    // Check if getUserMedia is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Microphone not available (HTTPS required on mobile)');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;

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
          }
        } catch (err) {
          setError(err.message || 'Transcription failed');
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Recording error:', err.name, err.message);
      if (err.name === 'NotAllowedError') {
        setError('Microphone access denied');
      } else if (err.name === 'NotSupportedError') {
        setError('Microphone not supported (HTTPS required)');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found');
      } else {
        setError(`Could not start recording: ${err.message}`);
      }
    }
  }, [onTranscribed]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return {
    isRecording,
    isTranscribing,
    error,
    toggleRecording,
    startRecording,
    stopRecording
  };
}
