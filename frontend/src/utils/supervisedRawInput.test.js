import { describe, expect, it, vi } from 'vitest';
import { createSupervisedRawInputStore } from './supervisedRawInputStore';
import { sendSupervisedRawInput, reviewSupervisedRawInput } from './supervisedRawInput';

function setup() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), listKeys: prefix => [...values.keys()].filter(key => key.startsWith(prefix)), transaction: callback => Promise.resolve().then(callback) };
  const operation = { requestId: '018fdf56-2333-7abc-8abc-123456789abc', deliveryToken: 'fixture-token' };
  const api = { issue: vi.fn().mockResolvedValue(operation), send: vi.fn().mockResolvedValue({ requestId: operation.requestId, status: 'delivered' }),
    lookup: vi.fn(), review: vi.fn().mockResolvedValue({ requestId: operation.requestId, status: 'acknowledged' }) };
  const options = { sessionId: 'ss-fixture', text: '\r', store: createSupervisedRawInputStore(storage, 'ss-fixture', () => true),
    api, isCurrent: () => true, withLock: callback => callback() };
  return { api, options, operation, values };
}

describe('supervised raw input', () => {
  it('persists the server identity before sending, then clears it only for a matching delivery receipt', async () => {
    const { api, options, operation } = setup();
    api.send.mockImplementation(async body => {
      expect(options.store.read()).toEqual({ version: 2, sessionId: 'ss-fixture', ...operation, stage: 'sending' });
      expect(body).toEqual({ text: '\r', fallbackToMessage: false, ...operation });
      return { requestId: operation.requestId, status: 'delivered' };
    });
    expect(await sendSupervisedRawInput(options)).toEqual({ status: 'delivered', requestId: operation.requestId });
    expect(api.review).toHaveBeenCalledWith(operation.requestId);
    expect(options.store.read()).toBeNull();
  });

  it('retains a confirmed delivery if its acknowledgment is lost, and can recover it later', async () => {
    const { api, options, operation } = setup();
    api.review.mockRejectedValueOnce(new TypeError('acknowledgment lost'));
    expect(await sendSupervisedRawInput(options)).toEqual({ status: 'uncertain', requestId: operation.requestId });
    expect(options.store.read().requestId).toBe(operation.requestId);
    api.lookup.mockResolvedValue({ requestId: operation.requestId, status: 'delivered' });
    expect(await reviewSupervisedRawInput({ ...options, acknowledged: true })).toEqual({ status: 'acknowledged', requestId: operation.requestId });
    expect(options.store.read()).toBeNull();
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('retains an uncertain operation and blocks a second send after a lost or mismatched response', async () => {
    const { api, options, operation } = setup();
    api.send.mockRejectedValueOnce(new TypeError('response lost'));
    expect(await sendSupervisedRawInput(options)).toEqual({ status: 'uncertain', requestId: operation.requestId });
    expect(await sendSupervisedRawInput(options)).toEqual({ status: 'review_required', requestId: operation.requestId });
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.issue).toHaveBeenCalledTimes(1);
  });

  it('requires explicit review before settling an uncertain receipt and never resends input', async () => {
    const { api, options, operation } = setup();
    await options.store.reserve(operation); await options.store.markSending(operation.requestId);
    api.lookup.mockResolvedValue({ requestId: operation.requestId, status: 'uncertain' });
    expect(await reviewSupervisedRawInput({ ...options, acknowledged: false })).toEqual({ status: 'uncertain', requestId: operation.requestId });
    expect(api.review).not.toHaveBeenCalled();
    api.review.mockResolvedValue({ requestId: operation.requestId, status: 'reviewed' });
    expect(await reviewSupervisedRawInput({ ...options, acknowledged: true })).toEqual({ status: 'reviewed', requestId: operation.requestId });
    expect(options.store.read()).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('keeps a missing or mismatched receipt unresolved', async () => {
    const { api, options, operation } = setup();
    await options.store.reserve(operation); await options.store.markSending(operation.requestId);
    api.lookup.mockResolvedValue({ requestId: '018fdf56-2333-7abc-8abc-123456789abd', status: 'delivered' });
    expect(await reviewSupervisedRawInput({ ...options, acknowledged: true })).toEqual({ status: 'unknown', requestId: operation.requestId });
    expect(options.store.read().requestId).toBe(operation.requestId);
    expect(api.review).not.toHaveBeenCalled();
  });

  it('keeps the operation if the account or environment changes before delivery is confirmed', async () => {
    const { api, options, operation } = setup();
    let current = true;
    options.isCurrent = () => current;
    api.send.mockImplementation(async () => { current = false; return { requestId: operation.requestId, status: 'delivered' }; });
    expect(await sendSupervisedRawInput(options)).toEqual({ status: 'uncertain', requestId: operation.requestId });
    expect(options.store.read().requestId).toBe(operation.requestId);
  });

  it('never sends raw input if the issued identity cannot be saved', async () => {
    const { api, options } = setup();
    options.store.reserve = () => { throw new Error('storage quota'); };
    await expect(sendSupervisedRawInput(options)).rejects.toThrow('storage quota');
    expect(api.issue).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });
});
