import { getActiveEnvironment } from './remoteEnvironments';

export function environmentAllows(environment, capability) {
  return !environment || environment.capabilities?.[capability] === true;
}
export function requireEnvironmentCapability(capability, action) {
  const environment = getActiveEnvironment();
  if (!environmentAllows(environment, capability)) {
    throw new Error((environment.label || 'This remote host') + ' does not allow ' + action + '. Ask its owner to pair this device with that permission.');
  }
}
