import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { webcrypto } from 'node:crypto';
import { Blob } from 'node:buffer';
vi.stubGlobal('Blob', Blob);
vi.stubGlobal('crypto', webcrypto);
import { apiFetch } from './api';
import { bytesToHex, hexToBytes, uploadChunks, downloadChunks } from './fileTransfers';
const response = body => ({ ok: true, json: async () => body });
describe('file transfer chunks', () => {
 beforeEach(() => vi.clearAllMocks());
 it('converts all binary bytes and rejects malformed chunks', () => { expect(Array.from(hexToBytes(bytesToHex(new Uint8Array([0, 127, 255]))))).toEqual([0, 127, 255]); expect(() => hexToBytes('0g')).toThrow(); });
 it('resumes uploading from the server offset and verifies completion', async () => {
  const file = { size: 5, slice: (start, end) => ({ arrayBuffer: async () => new TextEncoder().encode('hello'.slice(start, end)).buffer }) };
  apiFetch.mockResolvedValueOnce(response({ id: 'id', size: 5, offset: 3, status: 'pending' })).mockResolvedValueOnce(response({ id: 'id', size: 5, offset: 3, status: 'pending' })).mockResolvedValueOnce(response({ id: 'id', size: 5, offset: 5, status: 'pending' })).mockResolvedValueOnce(response({ id: 'id', size: 5, offset: 5, status: 'completed' }));
  const done = await uploadChunks({ id: 'id', size: 5 }, file);
  expect(done.status).toBe('completed');expect(apiFetch.mock.calls[2][1].body).toMatchObject({ offset: 3, data: '6c6f' });
 });
 it('uploads a checked chunk when SubtleCrypto is unavailable over HTTP', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  try {
   const file = { size: 2, slice: () => ({ arrayBuffer: async () => new TextEncoder().encode('hi').buffer }) };
   apiFetch.mockResolvedValueOnce(response({ id: 'http', size: 2, offset: 0, status: 'pending' }))
    .mockResolvedValueOnce(response({ id: 'http', size: 2, offset: 2, status: 'pending' }))
    .mockResolvedValueOnce(response({ id: 'http', size: 2, offset: 2, status: 'completed' }));
   await uploadChunks({ id: 'http', size: 2 }, file);
   expect(apiFetch.mock.calls[1][1].body).toEqual({ offset: 0, data: '6869', sha256: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4' });
  } finally { vi.stubGlobal('crypto', webcrypto); }
 });
 it('rejects download checksum mismatch before completion', async () => { apiFetch.mockResolvedValueOnce(response({ data: '6869', sha256: 'wrong', offset: 0, size: 2 })); await expect(downloadChunks({ id: 'id', size: 2 })).rejects.toThrow('checksum'); expect(apiFetch).toHaveBeenCalledTimes(1); });
});

describe('download delivery recovery', () => {
 it('retries completion after a lost acknowledgment and saves completed transfers', async () => {
  const { checksum } = await import('./fileTransfers');
  const chunk = { offset: 0, data: '6869', sha256: await checksum(new TextEncoder().encode('hi')) };
  apiFetch.mockReset();
  apiFetch.mockResolvedValueOnce(response(chunk)).mockRejectedValueOnce(new Error('Lost acknowledgment'));
  await expect(downloadChunks({ id: 'retry', size: 2, sha256: chunk.sha256 })).rejects.toThrow('Lost acknowledgment');
  apiFetch.mockResolvedValueOnce(response(chunk)).mockResolvedValueOnce(response({ status: 'completed' }));
  const blob = await downloadChunks({ id: 'retry', size: 2, sha256: chunk.sha256, status: 'completed' });
  expect(blob.size).toBe(2);
 });
});
