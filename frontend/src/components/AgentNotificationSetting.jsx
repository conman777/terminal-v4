import { useState } from 'react';
import { agentNotificationsEnabled, requestAgentNotifications, setAgentNotificationsEnabled } from '../utils/agentNotifications';

export function AgentNotificationSetting() {
  const [enabled, setEnabled] = useState(agentNotificationsEnabled);
  const [note, setNote] = useState('');
  const turnOn = async () => {
    const permission = await requestAgentNotifications();
    setEnabled(permission === 'granted');
    setNote(permission === 'granted' ? '' : permission === 'unsupported'
      ? 'This browser cannot show notifications.' : 'Notifications are blocked for this site in your browser settings.');
  };
  const turnOff = () => { setAgentNotificationsEnabled(false); setEnabled(false); setNote(''); };
  return (
    <div className="form-group session-settings-field">
      <label>Agent Notifications</label>
      <div className="mode-toggle" role="group" aria-label="Agent notifications">
        <button type="button" className={`mode-btn ${enabled ? 'active' : ''}`} aria-pressed={enabled} onClick={turnOn}>On</button>
        <button type="button" className={`mode-btn ${!enabled ? 'active' : ''}`} aria-pressed={!enabled} onClick={turnOff}>Off</button>
      </div>
      <small>{note || 'Notify me when a thread finishes or needs my approval while I am in another window.'}</small>
    </div>
  );
}
