import React from 'react';
import { createRoot } from 'react-dom/client';
import { RawInputRecovery } from '../../src/components/RawInputRecovery';
import { RawInputPending } from '../../src/components/RawInputPending';
import { setEnvironmentIdentity } from '../../src/utils/remoteEnvironments';
import { getUser } from '../../src/utils/auth';
import { supervisedInputQueue } from '../../src/utils/supervisedRawInputQueue';
import { sendRawInput } from '../../src/utils/supervisedRawInputController';

setEnvironmentIdentity(getUser()?.id, window.location.origin);
window.fixtureGetQueue = sessionId => supervisedInputQueue(sessionId, text => sendRawInput(sessionId, text, () => { throw new Error('unexpected legacy path'); }, { requireSupervision: true }));
createRoot(document.getElementById('root')).render(<main><p>Isolated raw input fixture</p><RawInputRecovery /><RawInputPending /></main>);
