import { getEnvironmentSignal, getEnvironmentStorage } from './remoteEnvironments';

const RECOVERY = 'Terminal delivery could not be confirmed. The command may have reached the shell. Inspect the terminal to check whether it ran; replay is blocked here. Use a new terminal session for any deliberate resend. Your draft was kept.';
const leases = new WeakMap();

export function prepareTerminalInput(sessionId, delivery) {
  if (delivery) {
    const lease = leases.get(delivery);
    if (!lease || lease.sessionId !== sessionId) throw new Error('Terminal command delivery does not belong to this session. Your draft was kept.');
    lease.assertCurrent();
    return;
  }
  try {
    const storage = getEnvironmentStorage();
    const key = `terminalCommandDelivery:v1:${sessionId}`;
    const raw = storage.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Change the marker even during an uncertain write so its late receipt cannot revive recovery.
    storage.setItem(key, JSON.stringify({ ...saved, uncertain: true, inputRevision: (saved.inputRevision || 0) + 1 }));
  } catch {
    throw new Error('Terminal input could not invalidate saved command recovery. No input was sent. Inspect the terminal before continuing. Your draft was kept.');
  }
}

export function claimTerminalCommand(sessionId, text) {
  if (!sessionId || !text) throw new Error('Choose a terminal and enter a command first.');
  const signal = getEnvironmentSignal();
  const storage = getEnvironmentStorage();
  const key = `terminalCommandDelivery:v1:${sessionId}`;
  let raw;
  let saved;
  try {
    raw = storage.getItem(key);
    saved = raw ? JSON.parse(raw) : null;
    if (saved && (saved.version !== 1 || typeof saved.text !== 'string'
      || !['text', 'submit'].includes(saved.phase) || typeof saved.uncertain !== 'boolean')) throw new Error();
  } catch {
    throw new Error('Terminal delivery state could not be read. Inspect the terminal before continuing in a new session. Your draft was kept.');
  }
  if (saved?.uncertain) throw new Error(RECOVERY);
  if (saved?.phase === 'submit' && saved.text !== text) {
    throw new Error('The previous command text was already sent. Restore that unchanged draft to retry Enter only, or inspect the terminal and use a new session. Your edited draft was kept.');
  }
  let state = { version: 1, text, phase: saved?.phase || 'text', uncertain: false };
  let attempted = false;
  const save = (next) => {
    if (signal.aborted) throw new Error('The terminal environment changed. Your draft was kept.');
    try {
      if (storage.getItem(key) !== raw) throw new Error();
      const nextRaw = next ? JSON.stringify(next) : null;
      if (nextRaw === null) storage.removeItem(key);
      else storage.setItem(key, nextRaw);
      raw = nextRaw;
      state = next;
    } catch {
      throw new Error('Terminal delivery progress could not be saved. Inspect the terminal before continuing. Your draft was kept.');
    }
  };
  const delivery = {
    phase: state.phase,
    beforeSend() {
      // Persist uncertainty before dispatch so a lost response or remount cannot replay it.
      save({ ...state, uncertain: true });
      attempted = true;
    },
    notAccepted() {
      save({ ...state, uncertain: false });
      attempted = false;
    },
    acceptText() {
      save({ ...state, phase: 'submit', uncertain: false });
      attempted = false;
    },
    complete() {
      save(null);
      attempted = false;
    },
    failure(error) {
      if (!attempted) return error;
      if (error.definitelyRejected === true) {
        save({ ...state, uncertain: false });
        attempted = false;
        return state.phase === 'submit'
          ? new Error('Command text was accepted, but Enter was rejected. Retry this unchanged draft to send Enter only. Your draft was kept.')
          : error;
      }
      return new Error(RECOVERY);
    },
  };
  leases.set(delivery, { sessionId, assertCurrent() {
    if (signal.aborted || !attempted || storage.getItem(key) !== raw) {
      throw new Error('Terminal input changed during command delivery. Inspect the terminal before continuing; replay is blocked here. Your draft was kept.');
    }
  } });
  return delivery;
}
