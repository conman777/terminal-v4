import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createTerminalReconnectController,
  shouldReuseTerminalSocket
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
