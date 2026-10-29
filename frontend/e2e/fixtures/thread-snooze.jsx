import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { MobileHeader } from '../../src/components/MobileHeader';
import ThreadsSidebar from '../../src/components/ThreadsSidebar';
import '../../src/styles.css';

function Fixture() {
  const [session, setSession] = useState({ id: 'ss-snooze-fixture', title: 'Synthetic thread', cwd: '/fixture', isBusy: true,
    thread: { topic: 'Synthetic thread', projectPath: '/fixture' }, threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } });
  const updateThread = async (_id, update) => {
    setSession(current => ({ ...current, threadLifecycle: { supported: true, snoozed: Boolean(update.snoozeForSeconds), requiresAttention: false } }));
    return update.snoozeForSeconds ? { snooze: { untilMs: Date.now() + 3600000, afterSeq: 1 } } : {};
  };
  const groups = [{ projectName: 'Fixture', projectPath: '/fixture', sessions: [session] }];
  const desktop = new URLSearchParams(location.search).get('layout') === 'desktop';
  return <ThemeProvider>
    {desktop ? <div style={{ height: 650, display: 'flex' }}><ThreadsSidebar isCollapsed={false} sessionsGroupedByProject={groups} pinnedSessions={[]} archivedSessions={[]} projects={[]}
      activeSessionId={session.id} sessionActivity={{ [session.id]: { isBusy: true } }} onSelectSession={() => {}} onUpdateThreadMetadata={updateThread} /></div>
      : <MobileHeader activeSessions={[session]} activeSessionId={session.id} sessionsGroupedByProject={groups} sessionActivity={{ [session.id]: { isBusy: true } }}
        onSelectSession={() => {}} onUpdateThreadMetadata={updateThread} />}
    <main style={{ paddingTop: desktop ? 0 : 100 }}><label>Unsent draft<textarea defaultValue="Synthetic unsent draft" /></label>
      <button type="button" onClick={() => setSession(current => ({ ...current, threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } }))}>Simulate pending request</button></main>
  </ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<Fixture />);
