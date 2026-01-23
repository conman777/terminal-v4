import { useRef, useEffect } from 'react';

export function AudioWaveform({ audioStream, width = 120, height = 32, barCount = 24 }) {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);

  useEffect(() => {
    if (!audioStream) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create AudioContext and Analyser
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioContextRef.current = audioCtx;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.7;
    analyserRef.current = analyser;

    // Connect stream to analyser
    const source = audioCtx.createMediaStreamSource(audioStream);
    source.connect(analyser);
    sourceRef.current = source;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Bar dimensions
    const barWidth = Math.max(2, (width - (barCount - 1) * 2) / barCount);
    const gap = 2;
    const minHeight = 4;
    const maxHeight = height - 4;

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);

      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      // Draw bars
      for (let i = 0; i < barCount; i++) {
        // Use frequency bins, mapping to bar count
        const dataIndex = Math.floor(i * bufferLength / barCount);
        const value = dataArray[dataIndex] || 0;

        // Scale value to bar height
        const barHeight = minHeight + (value / 255) * (maxHeight - minHeight);

        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;

        // Rounded rectangle
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        const radius = Math.min(barWidth / 2, 2);
        ctx.roundRect(x, y, barWidth, barHeight, radius);
        ctx.fill();
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      // Cleanup
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect();
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [audioStream, width, height, barCount]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="audio-waveform"
    />
  );
}
