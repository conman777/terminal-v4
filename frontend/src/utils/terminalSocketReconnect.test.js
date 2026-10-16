import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createTerminalReconnectController,
  shouldReuseTerminalSocket, reconnectDelay, isPermanentSocketClose
} from './terminalSocketReconnect';

describe('shouldReuseTerminalSocket', () => {
  it('reuses an active socket unless a force reconnect is requested', () => {
    expect(shouldReuseTerminalSocket({
      existingReadyState: WebSocket.OPEN,
      isConnecting: false,
      force: false
    })).toBe(true);

    expect(shouldReuseTerminalSocket({
      existingReadyState: WebSocket.CONNECTING,
      isConnecting: false,
      force: false
    })).toBe(true);

    expect(shouldReuseTerminalSocket({
      existingReadyState: WebSocket.OPEN,
      isConnecting: false,
      force: true
    })).toBe(false);
  });

  it('allows a new connect when no socket is active', () => {
    expect(shouldReuseTerminalSocket({
      existingReadyState: WebSocket.CLOSED,
      isConnecting: false,
      force: false
    })).toBe(false);

    expect(shouldReuseTerminalSocket({
      existingReadyState: undefined,
      isConnecting: true,
      force: false
    })).toBe(true);
  });
});

describe('createTerminalReconnectController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces reconnect timers so only the latest pending reconnect fires', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const controller = createTerminalReconnectController(onReconnect);

    controller.scheduleReconnect(1000, { reason: 'first' });
    controller.scheduleReconnect(200, { reason: 'latest' });

    vi.advanceTimersByTime(199);
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledWith({ reason: 'latest' });
  });

  it('invalidates older attempts when a newer connect attempt starts', () => {
    const controller = createTerminalReconnectController(vi.fn());

    const firstAttempt = controller.beginAttempt();
    const secondAttempt = controller.beginAttempt();

    expect(controller.isCurrentAttempt(firstAttempt)).toBe(false);
    expect(controller.isCurrentAttempt(secondAttempt)).toBe(true);
  });
});

describe('reconnect policy', () => {
  afterEach(() => vi.useRealTimers());
  it('uses bounded exponential delay and jitter', () => {
    expect([0, 1, 2, 12].map(attempt => reconnectDelay(attempt, () => 0.5))).toEqual([1000, 2000, 4000, 30000]);
    expect([reconnectDelay(0, () => 0), reconnectDelay(0, () => 1)]).toEqual([800, 1200]);
  });
  it('waits for the network before retrying and never revives a stopped controller', () => {
    vi.useFakeTimers();
    let online = false;
    const target = new EventTarget();
    const retry = vi.fn();
    const controller = createTerminalReconnectController(retry, { online: () => online, eventTarget: target, random: () => 0.5 });
    controller.scheduleReconnect();
    controller.scheduleReconnect();
    vi.advanceTimersByTime(30000);
    expect(retry).not.toHaveBeenCalled();
    online = true;
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledExactlyOnceWith({});
    controller.stop();
    controller.scheduleReconnect(0);
    target.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60000);
    expect(retry).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it('treats remote revocation and policy denial as permanent while allowing transient disconnects', () => {
    expect([
      isPermanentSocketClose({ code: 1008 }, true),
      isPermanentSocketClose({ code: 4401 }, true),
      isPermanentSocketClose({ code: 4404 }, true),
      isPermanentSocketClose({ code: 4401 }, false),
      isPermanentSocketClose({ code: 1006 }, true),
    ]).toEqual([true, true, true, false, false]);
  });
});
