import { describe, expect, it, vi } from 'vitest';
import { createSupervisedRawInputApi, supervisedInputAvailability, supervisedInputWatermark, supervisedRawInputCapability } from './supervisedRawInputApi';

const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
describe('supervised raw input HTTP contract', () => {
  it('distinguishes an unsupported backend from invalid or unavailable capability', async () => {
    expect(await supervisedRawInputCapability(async () => response(404, {}))).toBe(false);
    expect(await supervisedRawInputCapability(async () => response(200, { protocol: 1 }))).toBe(true);
    await expect(supervisedRawInputCapability(async () => response(200, {}))).rejects.toThrow();
    await expect(supervisedRawInputCapability(async () => response(503, {}))).rejects.toThrow();
  });

  it('identifies an installed disabled server without enabling new input', async () => {
    const disabled = async () => response(200, { protocol: 1, enabled: false });
    expect(await supervisedInputAvailability(disabled)).toBe('disabled');
    await expect(supervisedRawInputCapability(disabled)).rejects.toThrow('disabled');
    await expect(supervisedInputAvailability(async () => response(200, { protocol: 1, enabled: 'false' }))).rejects.toThrow();
  });

  it('accepts only an authenticated, well-formed server watermark', async () => {
    expect(await supervisedInputWatermark(async () => response(200, { protocol: 1, rejectBefore: 1234 }))).toBe(1234);
    for (const value of [{ protocol: 1 }, { protocol: 1, rejectBefore: -1 }, { protocol: 2, rejectBefore: 1234 }]) {
      await expect(supervisedInputWatermark(async () => response(200, value))).rejects.toThrow();
    }
    await expect(supervisedInputWatermark(async () => response(404, {}))).rejects.toThrow();
  });

  it('requires correctly bound delivery and review receipts', async () => {
    const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
    const fetch = vi.fn().mockResolvedValueOnce(response(200, { protocol: 1, requestId, deliveryToken: 'signed' }))
      .mockResolvedValueOnce(response(202, { status: 'accepted', outcome: 'delivered', requestId }))
      .mockResolvedValueOnce(response(200, { status: 'uncertain', sessionId: 'ss-fixture', requestId }))
      .mockResolvedValueOnce(response(200, { status: 'reviewed', sessionId: 'ss-fixture', requestId }))
      .mockResolvedValueOnce(response(200, { status: 'acknowledged', sessionId: 'ss-fixture', requestId }));
    const api = createSupervisedRawInputApi(fetch, 'ss-fixture', new AbortController().signal);
    expect(await api.issue()).toEqual({ requestId, deliveryToken: 'signed' });
    expect(await api.send({ text: '\r', fallbackToMessage: false, requestId, deliveryToken: 'signed' })).toEqual({ requestId, status: 'delivered' });
    expect(await api.lookup(requestId)).toEqual({ requestId, status: 'uncertain' });
    expect(await api.review(requestId)).toEqual({ requestId, status: 'reviewed' });
    expect(await api.review(requestId)).toEqual({ requestId, status: 'acknowledged' });
  });

  it('does not report delivery for a rejected, untyped, or mismatched response', async () => {
    const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
    for (const result of [response(409, { outcome: 'uncertain', requestId }), response(202, { status: 'accepted' }), response(202, { status: 'accepted', outcome: 'delivered', requestId: 'other' })]) {
      const api = createSupervisedRawInputApi(async () => result, 'ss-fixture', new AbortController().signal);
      await expect(api.send({ requestId })).rejects.toThrow();
    }
  });
});
