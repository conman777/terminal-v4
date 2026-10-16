import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './DeviceRelayPanel.css';

export function DeviceRelayPanel({ onPaired }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [relayUrl, setUrl] = useState('');
  const [deviceId, setId] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    apiFetch('/api/relay/status', { home: true, signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load relay status');
      if (live.current) setStatus(data);
    }).catch(error => {
      if (live.current && error.name !== 'AbortError') setError(error.message);
    });
    return () => { live.current = false; controller.abort(); };
  }, []);

  async function pair(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/environments/connect', {
        home: true,
        method: 'POST',
        body: { relayUrl: relayUrl.trim(), deviceId: deviceId.trim(), code: code.trim(), label: label.trim() },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Device pairing failed');
      if (live.current) { setCode(''); await onPaired?.(data); }
    } catch (error) {
      if (live.current) setError(error.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return <section className="device-relay-panel" aria-label="Device ID connections">
    <h3>Connect by device ID</h3>
    {status && <>
      <p>This computer: <code className="device-relay-id">{status.deviceId}</code></p>
      <p role="status">{status.connected ? 'Connected to relay' : status.configured ? 'Relay reconnecting' : 'Outbound relay disabled'}{status.brokerEnabled ? ' · Relay broker enabled' : ''}</p>
    </>}
    <p>Use a trusted self-hosted relay when a direct connection is unavailable. The relay operator can access relayed traffic; TLS protects each network connection.</p>
    <details>
      <summary>Set up a relay</summary>
      <p>On a relay server, set <code>TERMINAL_V4_RELAY_SERVER_KEY</code> to a strong shared secret and serve Terminal v4 through HTTPS with WebSocket support. On each device, set <code>TERMINAL_V4_RELAY_URL</code> and <code>TERMINAL_V4_RELAY_KEY</code>, then restart its server. Each device keeps its own persistent registration secret. Create a pairing code on the remote device before connecting here.</p>
    </details>
    <form onSubmit={pair}>
      <label>Relay URL<input type="url" required placeholder="https://relay.example.com" value={relayUrl} onChange={event => setUrl(event.target.value)} /></label>
      <label>Remote device ID<input required maxLength={36} value={deviceId} onChange={event => setId(event.target.value)} /></label>
      <label>Relay pairing code<input required type="password" autoComplete="off" maxLength={64} value={code} onChange={event => setCode(event.target.value)} /></label>
      <label>Relay device name<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <button disabled={busy} type="submit">{busy ? 'Pairing device…' : 'Pair device by ID'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>;
}
