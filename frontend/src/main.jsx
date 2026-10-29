import './utils/abortCompatibility';
import { applyAppearance, loadAppearance } from './utils/appearance';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { isWebContainerRoute } from './utils/webcontainerWindow';
import { installBuildFreshnessReloader } from './utils/buildFreshness';
import './styles.css';
import './WorkspaceUI.css';

applyAppearance(loadAppearance());
const root = ReactDOM.createRoot(document.getElementById('root'));

if (isWebContainerRoute(window.location.pathname)) {
  import('./components/WebContainerWindow.jsx').then(({ default: WebContainerWindow }) => {
    root.render(<WebContainerWindow />);
  }).catch(() => root.render(<main className="startup-recovery" role="alert"><h2>Unable to open the preview workspace</h2><p>Reload this window to try again, or return to your workspace.</p><button type="button" className="btn-primary" onClick={() => window.location.reload()}>Reload</button><a href="/">Return to workspace</a></main>));
} else {
  if (!import.meta.env.DEV) installBuildFreshnessReloader();
  Promise.all([import('./App.jsx'), import('./WorkspaceShell.css')]).then(([{ default: App }]) => {
    root.render(<App />);
  }).catch(() => root.render(<main className="startup-recovery" role="alert"><h2>Unable to load the workspace</h2><p>Reload to reconnect to the latest application.</p><button type="button" className="btn-primary" onClick={() => window.location.reload()}>Reload</button></main>));
}
