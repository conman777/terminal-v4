import './KeyboardShortcutsSetting.css';
import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

const TELEGRAM_URL = '/api/messaging/telegram';

// Hermes-style messaging: reach your threads from Telegram through your own bot.
export function TelegramSetting() {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = async (options) => {
    setBusy(true); setError('');
    try {
      const response = await apiFetch(TELEGRAM_URL, options);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Telegram settings could not be saved.');
      setStatus(data);
      return true;
    } catch (failure) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  useEffect(() => { request(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="form-group session-settings-field">
      <label>Telegram</label>
      {!status ? <small role="status">Loading…</small> : !status.configured ? <>
        <small>Create a bot with @BotFather in Telegram, paste its token, then pair your chat. Only that chat can talk to your threads.</small>
        <form className="telegram-connect" onSubmit={async event => { event.preventDefault(); if (await request({ method: 'PUT', body: { token: token.trim() } })) setToken(''); }}>
          <input type="password" aria-label="Bot token" autoComplete="off" placeholder="123456:ABC…" value={token} onChange={event => setToken(event.target.value)} />
          <button type="submit" className="btn-primary" disabled={busy || !token.trim()}>Connect</button>
        </form>
      </> : <>
        {status.paired
          ? <small>Paired with @{status.botName}. In Telegram send /threads, then /use N, then just message the thread.</small>
          : status.pairingCode
            ? <small>Send /pair {status.pairingCode} to @{status.botName} from the Telegram chat you want to use.</small>
            : <small>Connected to @{status.botName}. Get a pairing code to link your chat.</small>}
        <div className="mode-toggle" role="group" aria-label="Telegram gateway">
          <button type="button" className={`mode-btn ${status.enabled ? 'active' : ''}`} aria-pressed={status.enabled} disabled={busy} onClick={() => request({ method: 'PATCH', body: { enabled: true } })}>On</button>
          <button type="button" className={`mode-btn ${!status.enabled ? 'active' : ''}`} aria-pressed={!status.enabled} disabled={busy} onClick={() => request({ method: 'PATCH', body: { enabled: false } })}>Off</button>
        </div>
        <div className="telegram-actions">
          {!status.paired && !status.pairingCode && <button type="button" className="btn-secondary" disabled={busy} onClick={() => request({ method: 'PATCH', body: { newPairingCode: true } })}>New pairing code</button>}
          {status.paired && <button type="button" className="btn-secondary" disabled={busy} onClick={() => request({ method: 'PATCH', body: { newPairingCode: true } })}>Pair a different chat</button>}
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => request({ method: 'DELETE' })}>Disconnect</button>
        </div>
      </>}
      {error && <p role="alert" className="workspace-profile-error">{error}</p>}
    </div>
  );
}
