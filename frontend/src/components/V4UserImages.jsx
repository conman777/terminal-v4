import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { cloneImageAttachments } from '../utils/userImageInput';
import { sha256Hex } from '../utils/sha256';
import './V4UserImages.css';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const authIdentity = () => { const scope = captureAuthScope(); return JSON.stringify([scope.generation, scope.home]); };

function UserImage({ sessionId, attachment, index, environmentSignal, authKey }) {
  const scope = useMemo(() => ({ sessionId, attachment, signal: environmentSignal, auth: captureAuthScope() }),
    [sessionId, attachment, environmentSignal, authKey]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const elementRef = useRef(null), urlRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState({ scope, status: 'loading', url: '' });
  const projected = image.scope === scope && !scope.signal.aborted && isAuthScopeCurrent(scope.auth)
    ? image : { status: 'loading', url: '' };

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(elementRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    let disposed = false;
    const current = () => !disposed && scopeRef.current === scope && !signal.aborted && isAuthScopeCurrent(scope.auth) && !getActiveEnvironment();
    const release = () => {
      if (urlRef.current?.scope !== scope) return;
      URL.revokeObjectURL(urlRef.current.url); urlRef.current = null;
    };
    const unavailable = () => { release(); if (current()) setImage({ scope, status: 'unavailable', url: '' }); };
    const revoked = () => { controller.abort(); release(); };
    scope.signal.addEventListener('abort', revoked, { once: true });
    setImage({ scope, status: 'loading', url: '' });
    if (!current()) unavailable();
    else void (async () => {
      try {
        const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/attachments/${attachment.attachmentId}/content`, { signal });
        if (!current()) return;
        const length = response.headers?.get('content-length');
        const mime = response.headers?.get('content-type')?.split(';')[0].trim();
        if (!response.ok || (length != null && (!Number.isSafeInteger(Number(length)) || Number(length) !== attachment.bytes))
          || (mime && mime !== attachment.mimeType)) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (!current()) return;
        if (blob.size < 1 || blob.size > MAX_IMAGE_BYTES || blob.size !== attachment.bytes || blob.type !== attachment.mimeType) throw new Error('Invalid image');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!current()) return;
        const prefix = new TextEncoder().encode(`v4-image-v1\0${attachment.mimeType}\0`);
        const typed = new Uint8Array(prefix.length + bytes.length); typed.set(prefix); typed.set(bytes, prefix.length);
        const hash = await sha256Hex(typed);
        if (!current()) return;
        if (hash !== attachment.artifactId) throw new Error('Image identity mismatch');
        release();
        const url = URL.createObjectURL(blob); urlRef.current = { scope, url };
        setImage({ scope, status: 'ready', url });
      } catch { unavailable(); }
    })();
    return () => { disposed = true; scope.signal.removeEventListener('abort', revoked); controller.abort(); release(); };
  }, [visible, scope, sessionId, attachment]);

  return <figure className="v4-user-image" ref={elementRef}>
    {projected.status === 'ready'
      ? <img src={projected.url} alt={`Attached image ${index + 1}: ${attachment.name}`} onError={() => {
        if (scopeRef.current !== scope) return;
        if (urlRef.current?.scope === scope) { URL.revokeObjectURL(urlRef.current.url); urlRef.current = null; }
        setImage({ scope, status: 'unavailable', url: '' });
      }} />
      : <p role="status">{projected.status === 'unavailable' ? 'Attached image unavailable.' : 'Loading attached image…'}</p>}
    <figcaption>{attachment.name}</figcaption>
  </figure>;
}

export function V4UserImages({ sessionId, attachments }) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const authKey = useSyncExternalStore(subscribeAuth, authIdentity);
  const images = useMemo(() => {
    if (attachments === undefined || (Array.isArray(attachments) && attachments.length === 0)) return [];
    try { return cloneImageAttachments(attachments); } catch { return null; }
  }, [attachments]);
  if (!images || environment || !sessionId) return <p className="v4-user-image-unavailable" role="status">Attached image unavailable.</p>;
  if (!images.length) return null;
  return <section className="v4-user-images" aria-label="Attached images">
    {images.map((attachment, index) => <UserImage key={`${sessionId}-${attachment.attachmentId}-${index}`} sessionId={sessionId}
      attachment={attachment} index={index} environmentSignal={signal} authKey={authKey} />)}
  </section>;
}
