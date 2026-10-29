import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { MobileHeader } from '../../src/components/MobileHeader';
import ThreadsSidebar from '../../src/components/ThreadsSidebar';
import '../../src/styles.css';

function Fixture() {
  const [session, setSession] = useState({ id: 'ss-settle-fixture', title: 'Synthetic thread', cwd: '/fixture', runtime: 'v4', status: 'idle', isBusy: false,
    thread: { topic: 'Synthetic thread', projectPath: '/fixture' }, threadLifecycle: { supported: true, snoozed: false, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false } });
  const updateThread = async (_id, update) => {
    setSession(current => ({ ...current, threadLifecycle: { ...current.threadLifecycle, settled: update.settled, canSettle: !update.settled } }));
    return update.settled ? { settlement: { afterSeq: 1, queueFingerprint: 'a'.repeat(64) } } : {};
  };
  const params = new URLSearchParams(location.search);
  const working = { id: 'ss-working-fixture', title: 'Background thread', cwd: '/fixture', status: 'running', isBusy: true,
    thread: { topic: 'Background thread', projectPath: '/fixture' }, threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } };
  const groups = [{ projectName: 'Fixture', projectPath: '/fixture', sessions: params.has('working') ? [session, working] : [session] }];
  const desktop = params.get('layout') === 'desktop';
  return <ThemeProvider>
    {desktop ? <div style={{ height: 650, display: 'flex' }}><ThreadsSidebar isCollapsed={false} sessionsGroupedByProject={groups} pinnedSessions={[]} archivedSessions={[]} projects={[]}
      activeSessionId={session.id} sessionActivity={{ [session.id]: { isBusy: false } }} onSelectSession={() => {}} onUpdateThreadMetadata={updateThread} /></div>
      : <MobileHeader activeSessions={[session]} activeSessionId={session.id} sessionsGroupedByProject={groups} sessionActivity={{ [session.id]: { isBusy: false } }}
        onSelectSession={() => {}} onUpdateThreadMetadata={updateThread} />}
    <main style={{ paddingTop: desktop ? 0 : 100 }}><label>Unsent draft<textarea defaultValue="Synthetic unsent draft" /></label>
      <button type="button" onClick={() => setSession(current => ({ ...current, threadLifecycle: { ...current.threadLifecycle, settled: false, canSettle: false, requiresAttention: true } }))}>Simulate pending request</button></main>
  </ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<Fixture />);
