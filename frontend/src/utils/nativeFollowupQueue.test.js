import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNativeFollowupQueue, newNativeFollowup } from './nativeFollowupQueue';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';

describe('native follow-up queue recovery', () => {
  beforeEach(() => { sessionStorage.clear(); setEnvironmentIdentity('queue-owner'); });
  afterEach(() => { vi.restoreAllMocks(); setEnvironmentIdentity(null); });

  it('restores pending and uncertain sends for review without replaying them', () => {
    const queue = getNativeFollowupQueue('queue-recovery');
    const first = newNativeFollowup('Sent perhaps'), second = newNativeFollowup('Still waiting');
    expect(queue.update(() => [{ ...first, status: 'sending' }, second])).toBe(true);
    setEnvironmentIdentity('another-owner');
    setEnvironmentIdentity('queue-owner');
    expect(getNativeFollowupQueue('queue-recovery').getSnapshot()).toEqual({ error: '', items: [
      { ...first, status: 'held' }, { ...second, status: 'recovered' },
    ] });
  });

  it('isolates records by account, environment, and session', () => {
    const item = newNativeFollowup('private follow-up');
    expect(getNativeFollowupQueue('same-session').update(() => [item])).toBe(true);
    expect(getNativeFollowupQueue('other-session').getSnapshot().items).toEqual([]);
    setActiveEnvironment({ id: 'remote-device' });
    expect(getNativeFollowupQueue('same-session').getSnapshot().items).toEqual([]);
    setActiveEnvironment(null);
    setEnvironmentIdentity('other-owner');
    expect(getNativeFollowupQueue('same-session').getSnapshot().items).toEqual([]);
    setEnvironmentIdentity('queue-owner');
    expect(getNativeFollowupQueue('same-session').getSnapshot().items).toEqual([{ ...item, status: 'recovered' }]);
  });

  it('does not admit a queue mutation when storage fails', () => {
    const queue = getNativeFollowupQueue('queue-storage-error');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(queue.update(() => [newNativeFollowup('Keep draft')])).toBe(false);
    expect(queue.getSnapshot()).toEqual({ items: [], error: expect.stringMatching(/queue could not be saved/i) });
  });

  it('fails closed when the saved queue is corrupt', () => {
    const queue = getNativeFollowupQueue('queue-corrupt');
    expect(queue.update(() => [newNativeFollowup('saved')])).toBe(true);
    const key = Object.keys(sessionStorage).find(value => value.includes('queue-corrupt'));
    sessionStorage.setItem(key, 'not valid json');
    setEnvironmentIdentity('other-owner');
    setEnvironmentIdentity('queue-owner');
    const recovered = getNativeFollowupQueue('queue-corrupt');
    expect(recovered.update(() => [newNativeFollowup('replacement')])).toBe(false);
    expect(recovered.getSnapshot().error).toMatch(/could not be read/i);
    expect(sessionStorage.getItem(key)).toBe('not valid json');
  });
});
