import { describe, expect, it } from 'vitest';
import { newThreadTerminalRecovery, sharedThreadTerminalOperationId } from './threadTerminalRecovery';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const auth = { home: 'home-one', userId: 'user-one' };

describe('sharedThreadTerminalOperationId', () => {
  it('is a stable version 4 shaped id for one account and thread', () => {
    expect([UUID.test(sharedThreadTerminalOperationId(auth, 'ss-1')), sharedThreadTerminalOperationId(auth, 'ss-1') === sharedThreadTerminalOperationId({ ...auth }, 'ss-1')]).toEqual([true, true]);
  });

  it('differs across threads, accounts and homes', () => {
    const ids = [
      sharedThreadTerminalOperationId(auth, 'ss-1'),
      sharedThreadTerminalOperationId(auth, 'ss-2'),
      sharedThreadTerminalOperationId({ ...auth, userId: 'user-two' }, 'ss-1'),
      sharedThreadTerminalOperationId({ ...auth, home: 'home-two' }, 'ss-1'),
      sharedThreadTerminalOperationId({ ...auth, userId: '' }, 'ss-1'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('newThreadTerminalRecovery', () => {
  it('stores a unique nonce even when two attempts share an operation id', () => {
    const operationId = sharedThreadTerminalOperationId(auth, 'ss-1');
    const [left, right] = [newThreadTerminalRecovery('ss-1', '/work', operationId), newThreadTerminalRecovery('ss-1', '/work', operationId)];
    expect([left.operationId === right.operationId, JSON.stringify(left) === JSON.stringify(right), left.phase]).toEqual([true, false, 'creating']);
  });
});
