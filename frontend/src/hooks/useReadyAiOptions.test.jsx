import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadyAiOptions } from './useReadyAiOptions';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

const options = [{ id: null, label: 'CLI (default)' }, { id: 'claude', label: 'Claude Code' }, { id: 'deepseek', label: 'DeepSeek' }];

describe('useReadyAiOptions', () => {
  beforeEach(() => apiFetch.mockReset());

  it('narrows the agent menu to agents the host can run', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'claude', available: true }, { id: 'deepseek', available: false }] }) });
    const { result } = renderHook(() => useReadyAiOptions(options, null));
    await waitFor(() => expect(result.current.map(option => option.label)).toEqual(['CLI (default)', 'Claude Code']));
  });

  it('keeps the full menu when the catalog request fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useReadyAiOptions(options, null));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current).toBe(options);
  });
});
