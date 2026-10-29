import { captureAuthScope, isAuthScopeCurrent } from './auth';
import { getEnvironmentCacheScope, getEnvironmentSignal, getEnvironmentStorage } from './remoteEnvironments';
import { createUuid } from './createUuid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prepareWorktreeCreation(project, surface) {
  const auth = captureAuthScope();
  if (!auth.userId) throw new Error('Sign in before creating an isolated worktree.');
  const environment = getEnvironmentCacheScope();
  const signal = getEnvironmentSignal();
  const storage = getEnvironmentStorage();
  const key = 'worktreeCreation:v1:' + JSON.stringify([new URL(auth.home).origin, auth.userId, environment.identity, environment.environment, project, surface]);
  const assertCurrent = () => {
    const current = getEnvironmentCacheScope();
    if (signal.aborted || !isAuthScopeCurrent(auth) || current.identity !== environment.identity || current.environment !== environment.environment) {
      throw new Error('Account or environment changed. Review the worktree before trying again.');
    }
  };
  assertCurrent();
  let operationId;
  try {
    const existing = storage.getItem(key);
    if (existing !== null && !UUID.test(existing)) throw new Error('Invalid saved request');
    operationId = existing || createUuid();
    if (!existing) storage.setItem(key, operationId);
    if (storage.getItem(key) !== operationId) throw new Error('Saved request changed');
  } catch {
    throw new Error('Could not safely save the worktree request on this device. Your task was not started.');
  }
  function clear(message) {
    assertCurrent();
    try {
      if (storage.getItem(key) !== operationId) throw new Error('Saved request changed');
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error('Saved request could not be cleared');
    } catch { throw new Error(message); }
  }
  return {
    operationId,
    signal,
    assertCurrent,
    complete() { clear('The worktree request completed, but its recovery state could not be cleared. Review it in Git & worktrees before starting another.'); },
    discard() { clear('Could not clear the saved worktree request. Review the earlier attempt before continuing.'); },
  };
}
