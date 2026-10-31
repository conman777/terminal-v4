import { describe, expect, it } from 'vitest';
import { createStrictAuthNotifications } from './strictAuthNotifications';

class Channel {
  static instances = [];
  constructor() { this.sent = []; Channel.instances.push(this); }
  postMessage(value) {
    this.sent.push(value);
    for (const other of Channel.instances) if (other !== this && !other.closed) other.onmessage?.({ data: value });
  }
  close() { this.closed = true; }
}

describe('strict auth invalidation hints', () => {
  it('notifies this tab and independent subscribers without sending credentials', () => {
    Channel.instances = [];
    const a = createStrictAuthNotifications({ BroadcastChannel: Channel });
    const b = createStrictAuthNotifications({ BroadcastChannel: Channel });
    const seen = [];
    const stopA = a.subscribe(value => seen.push(['a', value]));
    b.subscribe(value => seen.push(['b', value]));
    expect(a.publish()).toBe(true);
    expect(seen).toEqual([['b', { status: 'changed' }], ['a', { status: 'changed' }]]);
    expect(Channel.instances[0].sent).toEqual([{ version: 1, kind: 'authority-changed' }]);
    stopA(); a.close(); b.close();
  });

  it('ignores malformed or secret-bearing messages', () => {
    Channel.instances = [];
    const a = createStrictAuthNotifications({ BroadcastChannel: Channel });
    const seen = [];
    a.subscribe(value => seen.push(value));
    Channel.instances[0].onmessage({ data: { version: 1, kind: 'authority-changed', token: 'synthetic-secret' } });
    Channel.instances[0].onmessage({ data: { version: 2, kind: 'authority-changed' } });
    expect(seen).toEqual([]);
    a.close();
  });

  it('fails closed when the channel is unavailable or publication fails', () => {
    const missing = createStrictAuthNotifications({ BroadcastChannel: undefined });
    expect(missing.publish()).toBe(false);
    expect(() => missing.subscribe(() => {})).toThrow(/unavailable/i);
    Channel.instances = [];
    const a = createStrictAuthNotifications({ BroadcastChannel: Channel });
    const seen = [];
    a.subscribe(value => seen.push(value));
    Channel.instances[0].postMessage = () => { throw new Error('synthetic failure'); };
    expect(a.publish()).toBe(false);
    expect(seen).toEqual([{ status: 'unavailable' }]);
    expect(() => a.subscribe(() => {})).toThrow(/unavailable/i);
    a.close();
  });
});
