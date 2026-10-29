import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupervisedRawInputQueue, dismissSupervisedInputScopeNotice, getSupervisedInputQueues, supervisedInputQueue } from './supervisedRawInputQueue';
import { setEnvironmentIdentity } from './remoteEnvironments';

afterEach(() => vi.useRealTimers());
describe('supervised interactive input batching', () => {
  it('batches ordered keystrokes and sends only one operation at a time', async () => {
    vi.useFakeTimers();
    let finish;
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ accepted: true });
    const queue = createSupervisedRawInputQueue(send, () => true);
    queue.enqueue('a'); queue.enqueue('b'); queue.enqueue('\x1b[A');
    await vi.advanceTimersByTimeAsync(40);
    expect(send.mock.calls).toEqual([['ab\x1b[A']]);
    queue.enqueue('c'); queue.enqueue('\r');
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    finish({ accepted: true });
    await vi.advanceTimersByTimeAsync(40);
    expect(send.mock.calls).toEqual([['ab\x1b[A'], ['c\r']]);
    expect(queue.getSnapshot().pending).toBe(0);
  });

  it('halts after uncertainty, never requeues that batch, and retains later unsent keys', async () => {
    vi.useFakeTimers();
    let fail;
    const send = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValue({ accepted: true });
    const queue = createSupervisedRawInputQueue(send, () => true);
    queue.enqueue('first'); await vi.advanceTimersByTimeAsync(40);
    queue.enqueue('later');
    const error = new Error('Delivery uncertain'); error.deliveryUncertain = true;
    fail(error); await vi.advanceTimersByTimeAsync(500);
    expect(queue.getSnapshot()).toMatchObject({ pending: 5, halted: true });
    expect(send).toHaveBeenCalledTimes(1);
    queue.resume(); await vi.advanceTimersByTimeAsync(40);
    expect(send.mock.calls).toEqual([['first'], ['later']]);
  });

  it('keeps a batch known not to have been sent and applies bounded backpressure', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('No input was sent')).mockResolvedValue({ accepted: true });
    const queue = createSupervisedRawInputQueue(send, () => true, 8);
    expect(queue.enqueue('12345678')).toBe(true);
    expect(queue.enqueue('9')).toBe(false);
    expect(queue.getSnapshot().error).toMatch(/full/);
    await vi.advanceTimersByTimeAsync(40);
    expect(queue.getSnapshot()).toMatchObject({ pending: 8, halted: true });
    queue.resume(); await vi.advanceTimersByTimeAsync(40);
    expect(send.mock.calls).toEqual([['12345678'], ['12345678']]);
  });

  it('keeps waiting keys across pane remounts and warns before closing the tab', () => {
    vi.useFakeTimers();
    const first = supervisedInputQueue('ss-waiting-keys', vi.fn());
    first.enqueue('waiting');
    const reopened = supervisedInputQueue('ss-waiting-keys', vi.fn());
    expect(reopened).toBe(first);
    expect(reopened.getSnapshot().pending).toBe(7);
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    reopened.discard();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });

  it('does not mix legacy and supervised batches while the input mode changes', async () => {
    vi.useFakeTimers();
    let finish;
    const legacy = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const supervised = vi.fn().mockResolvedValue({ accepted: true });
    const queue = supervisedInputQueue('ss-mode-change', legacy, 'legacy');
    expect(queue.enqueue('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(supervisedInputQueue('ss-mode-change', supervised, 'supervised').enqueue('b')).toBe(false);
    expect(queue.getSnapshot().error).toMatch(/mode changed/i);
    finish({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisedInputQueue('ss-mode-change', supervised, 'supervised').enqueue('c')).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(legacy.mock.calls).toEqual([['a']]);
    expect(supervised.mock.calls).toEqual([['c']]);
  });

  it('warns before closing while a batch is waiting for its operation to be issued', async () => {
    vi.useFakeTimers();
    let finish;
    const queue = supervisedInputQueue('ss-in-flight-keys', () => new Promise(resolve => { finish = resolve; }));
    queue.enqueue('waiting');
    await vi.advanceTimersByTimeAsync(40);
    expect(queue.getSnapshot()).toMatchObject({ pending: 0, sending: true });
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    finish({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });

  it('discards unsent keys on account change and leaves a content-free notice', () => {
    vi.useFakeTimers();
    setEnvironmentIdentity('queue-owner', window.location.origin);
    const queue = supervisedInputQueue('ss-scope-change', vi.fn());
    queue.enqueue('sensitive');
    setEnvironmentIdentity('another-owner', window.location.origin);
    expect(queue.getSnapshot().pending).toBe(0);
    expect(getSupervisedInputQueues()).toEqual([{ scopeChanged: true }]);
    dismissSupervisedInputScopeNotice();
    setEnvironmentIdentity(null);
  });

  it('warns that an in-flight batch may have been delivered after an account change', async () => {
    vi.useFakeTimers();
    setEnvironmentIdentity('queue-owner', window.location.origin);
    let finish;
    const queue = supervisedInputQueue('ss-inflight-scope', () => new Promise(resolve => { finish = resolve; }));
    queue.enqueue('secret');
    await vi.advanceTimersByTimeAsync(40);
    setEnvironmentIdentity('another-owner', window.location.origin);
    expect(getSupervisedInputQueues()).toEqual([{ scopeChanged: true, scopeUncertain: true }]);
    finish({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    dismissSupervisedInputScopeNotice();
    setEnvironmentIdentity(null);
  });
});
