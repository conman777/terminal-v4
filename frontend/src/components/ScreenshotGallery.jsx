import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import './ScreenshotGallery.css';

function Thumbnail({ filename }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let cancelled = false;
    apiFetch(`/api/preview/screenshots/${encodeURIComponent(filename)}`)
      .then(response => (response.ok ? response.blob() : null))
      .then(blob => { if (blob && !cancelled) { url = URL.createObjectURL(blob); setSrc(url); } })
      .catch(() => {});
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [filename]);
  return src ? <img src={src} alt={filename} /> : <div className="screenshot-placeholder" aria-hidden="true" />;
}

// Screenshots of preview apps: capture a running port and browse or delete saved shots.
export function ScreenshotGallery({ open, onClose }) {
  const [shots, setShots] = useState(null);
  const [port, setPort] = useState('');
  const [fullPage, setFullPage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const response = await apiFetch('/api/preview/screenshots');
    const data = await response.json().catch(() => null);
    const list = Array.isArray(data?.screenshots) ? data.screenshots : [];
    setShots([...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }, []);
  useEffect(() => { if (open) load().catch(() => setError('Screenshots could not be loaded.')); }, [load, open]);
  if (!open) return null;
  const capture = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/preview/${Number(port)}/screenshot`, { method: 'POST', body: { fullPage } });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || 'Capture failed'); }
      await load();
    } catch (failure) { setError(failure.message || 'Capture failed'); }
    finally { setBusy(false); }
  };
  const remove = async filename => {
    await apiFetch(`/api/preview/screenshots/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    await load();
  };
  const validPort = /^\d{2,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536;
  return (
    <div className="modal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="modal-content screenshot-gallery" role="dialog" aria-modal="true" aria-label="Screenshots" onKeyDown={event => { if (event.key === 'Escape') onClose?.(); }}>
        <header><h2>Screenshots</h2><button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button></header>
        <form className="screenshot-capture" onSubmit={capture}>
          <label>Port<input inputMode="numeric" value={port} onChange={event => setPort(event.target.value.trim())} placeholder="5173" /></label>
          <label className="screenshot-full"><input type="checkbox" checked={fullPage} onChange={event => setFullPage(event.target.checked)} />Full page</label>
          <button type="submit" disabled={!validPort || busy}>{busy ? 'Capturing…' : 'Capture'}</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {shots === null ? <p role="status">Loading screenshots…</p> : shots.length === 0 ? <p>No screenshots yet. Capture a running app by its port.</p>
          : <ul className="screenshot-grid">
            {shots.map(shot => <li key={shot.filename}>
              <Thumbnail filename={shot.filename} />
              <div><small>{new Date(shot.createdAt).toLocaleString()}</small>
                <button type="button" aria-label={`Delete ${shot.filename}`} onClick={() => remove(shot.filename)}>Delete</button></div>
            </li>)}
          </ul>}
      </div>
    </div>
  );
}
