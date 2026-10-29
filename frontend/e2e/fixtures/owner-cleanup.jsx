import React from 'react';
import '../../src/styles.css';
import { createRoot } from 'react-dom/client';
import OwnerCleanupRecovery from '../../src/components/OwnerCleanupRecovery';
import { getUser } from '../../src/utils/auth';
import { setEnvironmentIdentity } from '../../src/utils/remoteEnvironments';

setEnvironmentIdentity(getUser()?.id, window.location.origin);
createRoot(document.getElementById('root')).render(<main><p>Isolated cleanup fixture</p><OwnerCleanupRecovery /></main>);
