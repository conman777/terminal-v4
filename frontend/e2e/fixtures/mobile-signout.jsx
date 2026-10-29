import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { MobileHeader } from '../../src/components/MobileHeader';
import '../../src/styles.css';

function Fixture() {
  const [signouts, setSignouts] = useState(0);
  return <ThemeProvider>
    <MobileHeader activeSessions={[{ id: 'fixture-session', title: 'Fixture thread' }]} activeSessionId="fixture-session" onLogout={() => setSignouts(value => value + 1)} onOpenSettings={() => {}} />
    <main><label>Unsent draft<textarea defaultValue="Synthetic unsent draft" /></label><p role="status">Sign out calls: {signouts}</p></main>
  </ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<Fixture />);
