import { AgentBrowserSettingsPanel } from '../AgentBrowserSettingsPanel';

export function BrowserSettings() {
  return <>
    <AgentBrowserSettingsPanel />
    <p className="form-help">To clear the human browser's tabs and website sign-ins, open Browser actions → Reset in the Browser pane. Agent browser settings are saved on Home and do not change human browsing permissions.</p>
  </>;
}
