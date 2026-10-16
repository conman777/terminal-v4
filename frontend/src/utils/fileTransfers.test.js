import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
import { webcrypto } from 'node:crypto';
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
 it('rejects download checksum mismatch before completion', async () => { apiFetch.mockResolvedValueOnce(response({ data: '6869', sha256: 'wrong', offset: 0, size: 2 })); await expect(downloadChunks({ id: 'id', size: 2 })).rejects.toThrow('checksum'); expect(apiFetch).toHaveBeenCalledTimes(1); });
});
