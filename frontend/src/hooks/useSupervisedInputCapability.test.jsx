import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSupervisedInputCapability } from './useSupervisedInputCapability';
import { apiFetch } from '../utils/api';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
afterEach(() => { apiFetch.mockReset(); setActiveEnvironment(null); setEnvironmentIdentity(null); });

it.each([[404, {}, 'legacy'], [200, { protocol: 1 }, 'supervised'], [200, {}, 'unavailable'], [503, {}, 'unavailable']])('selects %s protocol behavior without assuming an error is legacy', async (status, body, mode) => {
  apiFetch.mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body });
  const hook = renderHook(() => useSupervisedInputCapability(true, 'ss-fixture'));
  await waitFor(() => expect(hook.result.current).toBe(mode));
});

it('rechecks support before re-enabling a structured input surface', async () => {
  apiFetch.mockResolvedValueOnce({ status: 404, ok: false });
  const hook = renderHook(({ enabled }) => useSupervisedInputCapability(enabled, 'ss-fixture'), { initialProps: { enabled: true } });
  await waitFor(() => expect(hook.result.current).toBe('legacy'));
  hook.rerender({ enabled: false });
  apiFetch.mockImplementationOnce(() => new Promise(() => {}));
  hook.rerender({ enabled: true });
  expect(hook.result.current).toBe('checking');
});

it('selects legacy for a session-level 404 and rechecks when the session changes', async () => {
  apiFetch.mockImplementation(async url => url.includes('/sessions/ss-old/')
    ? { status: 404, ok: false }
    : { status: 200, ok: true, json: async () => ({ protocol: 1 }) });
  const hook = renderHook(({ session }) => useSupervisedInputCapability(true, session), { initialProps: { session: 'ss-old' } });
  await waitFor(() => expect(hook.result.current).toBe('legacy'));
  hook.rerender({ session: 'ss-new' });
  expect(hook.result.current).toBe('checking');
  await waitFor(() => expect(hook.result.current).toBe('supervised'));
});

it('uses legacy mode for paired targets without probing unsupported paths', async () => {
  setEnvironmentIdentity('fixture-owner');
  setActiveEnvironment({ id: 'old-paired-target' });
  const hook = renderHook(() => useSupervisedInputCapability(true, 'ss-paired'));
  await waitFor(() => expect(hook.result.current).toBe('legacy'));
  expect(apiFetch).not.toHaveBeenCalled();
});

it('offers legacy input for an installed disabled server, subject to the send-time recovery check', async () => {
  apiFetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ protocol: 1, enabled: false }) });
  const hook = renderHook(() => useSupervisedInputCapability(true, 'ss-fixture'));
  await waitFor(() => expect(hook.result.current).toBe('legacy'));
});
