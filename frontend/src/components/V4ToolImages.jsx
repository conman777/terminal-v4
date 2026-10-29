import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { getEnvironmentSignal } from '../utils/remoteEnvironments';
import './V4ToolImages.css';

const FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_BYTES = 8 * 1024 * 1024;

function ToolImage({ sessionId, artifact, index }) {
  const [image, setImage] = useState({ status: 'loading', url: '' });
  const imageUrl = useRef(null);
  const release = useCallback(() => {
    if (imageUrl.current) { URL.revokeObjectURL(imageUrl.current); imageUrl.current = null; }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const environmentSignal = getEnvironmentSignal();
    const signal = AbortSignal.any([controller.signal, environmentSignal]);
    let disposed = false;
    setImage({ status: 'loading', url: '' });
    const unavailable = () => { release(); if (!disposed) setImage({ status: 'unavailable', url: '' }); };
    const revoked = () => { controller.abort(); unavailable(); };
    environmentSignal.addEventListener('abort', revoked, { once: true });
    const format = FORMATS[artifact.mimeType];
    if (!sessionId || !format || !/^[a-f0-9]{64}$/.test(artifact.artifactId || '') || signal.aborted) unavailable();
    else void (async () => {
      try {
        const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/artifacts/${artifact.artifactId}/${format}`, { signal });
        if (signal.aborted || disposed) return;
        if (!response.ok || Number(response.headers?.get('content-length')) > IMAGE_BYTES) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (signal.aborted || disposed) return;
        if (blob.size > IMAGE_BYTES || blob.type !== artifact.mimeType) throw new Error('Invalid image');
        imageUrl.current = URL.createObjectURL(blob);
        setImage({ status: 'ready', url: imageUrl.current });
      } catch { if (!signal.aborted && !disposed) unavailable(); }
    })();
    return () => { disposed = true; environmentSignal.removeEventListener('abort', revoked); controller.abort(); release(); };
  }, [sessionId, artifact.artifactId, artifact.mimeType, release]);

  if (image.status !== 'ready') return <p className="v4-tool-image-state" role="status">{image.status === 'loading' ? 'Loading tool image…' : 'Tool image unavailable.'}</p>;
  return <figure className="v4-tool-image"><img src={image.url} alt={`Tool image ${index + 1}`} onError={() => { release(); setImage({ status: 'unavailable', url: '' }); }} /></figure>;
}

export function V4ToolImages({ sessionId, content }) {
  const images = Array.isArray(content) ? content.filter(block => block?.type === 'v4_image') : [];
  if (!images.length) return null;
  return <section className="v4-tool-images" aria-label="Tool images">
    {images.slice(0, 8).map((artifact, index) => <ToolImage key={`${sessionId}-${artifact.artifactId}-${index}`} sessionId={sessionId} artifact={artifact} index={index} />)}
    {images.length > 8 && <p role="status">Additional tool images unavailable: this result exceeds the eight-image limit.</p>}
  </section>;
}
