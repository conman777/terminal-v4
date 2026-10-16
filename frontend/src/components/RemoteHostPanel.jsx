import { useState } from 'react';
import './RemoteHostPanel.css';

const literal = value => "'" + value.replaceAll("'", "''") + "'";
const validPath = value => /^[a-zA-Z]:\\/.test(value) && !/[\x00-\x1f"<>|?*]/.test(value);

export default function RemoteHostPanel() {
  const [repository, setRepository] = useState('C:\\path\\to\\terminal-v4');
  const [binary, setBinary] = useState('C:\\path\\to\\terminal-v4\\rust\\target\\release\\terminal-v4-api.exe');
  const [lan, setLan] = useState(false);
  const valid = validPath(repository) && validPath(binary) && /\\terminal-v4-api\.exe$/i.test(binary);
  const script = literal(repository.replace(/\\$/, '') + '\\scripts\\manage-remote-host.ps1');
  const commands = valid ? [
    '& ' + script + ' -Action Plan -ApiBinary ' + literal(binary) + (lan ? " -BindAddress '0.0.0.0' -AllowLan" : ''),
    '& ' + script + ' -Action Initialize -ApiBinary ' + literal(binary) + (lan ? " -BindAddress '0.0.0.0' -AllowLan" : ''),
    '& ' + script + ' -Action Start',
    '& ' + script + ' -Action Install',
    '& ' + script + ' -Action Status',
    "$env:TERMINAL_V4_BACKEND_MODE = 'attach'",
  ].join('\n') : '';
  return <section className="remote-host-panel" aria-label="Background host setup">
    <h3>Keep this computer available</h3>
    <p>Run the Terminal v4 API in the background, independently of the desktop window. The optional startup task launches after you sign in to Windows, including after a reboot.</p>
    <p>Connections still require your existing login and pairing permissions. Before initialization, set the same <code>JWT_SECRET</code>, <code>REFRESH_SECRET</code>, <code>STORAGE_DATABASE_URL</code>, and <code>TERMINAL_DATA_DIR</code> used by this host in the PowerShell environment. Initialization preserves the supplied signing secrets and encrypts credentials for your Windows user.</p>
    <label>Repository path<input autoComplete="off" value={repository} onChange={event => setRepository(event.target.value)} /></label>
    <label>API executable path<input autoComplete="off" value={binary} onChange={event => setBinary(event.target.value)} /></label>
    <label className="remote-host-consent"><input type="checkbox" checked={lan} onChange={event => setLan(event.target.checked)} />Listen on my local network</label>
    {lan && <p>Network listening exposes the API to your LAN. Use an HTTPS reverse proxy for encrypted connections outside localhost. This setup does not change Windows Firewall rules.</p>}
    {valid ? <><p>Run these commands on the computer you want to keep available. Build the release API first. Use Plan to inspect paths before Initialize; existing host configuration is never overwritten.</p>
      <pre data-testid="host-commands"><code>{commands}</code></pre>
      <p>Set the desktop attachment variable in the shell that launches the desktop app. Attached windows leave the host running when closed. The normal desktop mode continues to own its backend process.</p>
      <details><summary>Stop or remove startup</summary><pre><code>{'& ' + script + ' -Action Stop\n& ' + script + ' -Action Uninstall'}</code></pre><p>Stop interrupts host connections. Uninstall removes only the logon task; it preserves credentials and saved data.</p></details>
    </> : <p role="alert">Enter valid absolute Windows paths, with the API path ending in terminal-v4-api.exe.</p>}
    <p className="remote-host-note">The browser does not run these commands or install a service. Manage startup directly on the owning computer. Other platforms can use their normal service manager.</p>
  </section>;
}
