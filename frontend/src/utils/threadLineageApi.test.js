import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordThreadLineage } from './threadLineageApi';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch }));

describe('recordThreadLineage', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('saves the relationship and reports success', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await expect(recordThreadLineage('child', 'parent', 'fork')).resolves.toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/thread-lineage', { method: 'PUT', body: { childId: 'child', parentId: 'parent', kind: 'fork' } });
  });

  it('reports false instead of throwing when the save fails', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'));
    await expect(recordThreadLineage('c', 'p', 'fork')).resolves.toBe(false);
    await expect(recordThreadLineage('c', 'p', 'fork')).resolves.toBe(false);
  });
});
