// Explicit metadata/action accounting only. apiFetch retains every real mock call;
// actionHTTP forwards every non-catalog URL without editing calls or responses.
import { vi } from 'vitest';
export function installImageTransport(apiFetch) {
  const actionHTTP = vi.fn();
  apiFetch.mockImplementation((url, options) => {
    if (url === '/api/agent/catalog') return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [
      { id: 'openai', runtime: 'v4', models: [{ id: 'gpt-5.4', imageInput: true }, { id: 'text-only', imageInput: false }, { id: 'unknown-capability' }] },
    ] }) });
    return actionHTTP(url, options);
  });
  return actionHTTP;
}
export const catalogRequests = apiFetch => apiFetch.mock.calls.filter(([url]) => url === '/api/agent/catalog');
