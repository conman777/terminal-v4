import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueServerFollowup, probeServerFollowupQueue } from './serverFollowupQueue';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch }));
const SID = 'ss-00000000000000000000000000000001';
const empty = { revision: 3, mode: 'running', holdReason: null, items: [], order: [] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const receipt = (options, revision) => response({ operationId: options.body.operationId, queueRevision: revision, itemId: options.body.operation.itemId, itemRevision: 1 });

beforeEach(() => apiFetch.mockReset());

describe('probeServerFollowupQueue', () => {
  it('reports available with the validated snapshot', async () => {
    apiFetch.mockResolvedValueOnce(response(empty));
    expect(await probeServerFollowupQueue(SID)).toEqual({ status: 'available', snapshot: empty });
  });
  it.each([409, 404, 403])('reports unavailable with a reason for %s', async code => {
    apiFetch.mockResolvedValueOnce(response({ error: 'Follow-up queues are available only in V4 conversations' }, code));
    expect(await probeServerFollowupQueue(SID)).toEqual({ status: 'unavailable', reason: 'Follow-up queues are available only in V4 conversations' });
  });
  it('reports unknown, never unavailable, when the host cannot be reached or answers 5xx', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    expect((await probeServerFollowupQueue(SID)).status).toBe('unknown');
    apiFetch.mockResolvedValueOnce(response({}, 503));
    expect((await probeServerFollowupQueue(SID)).status).toBe('unknown');
  });
  it('reports unknown for an invalid snapshot so nothing is sent through it', async () => {
    apiFetch.mockResolvedValueOnce(response({ revision: 'x' }));
    expect((await probeServerFollowupQueue(SID)).status).toBe('unknown');
  });
});

describe('enqueueServerFollowup', () => {
  it('posts one enqueue against the current revision', async () => {
    apiFetch.mockResolvedValueOnce(response(empty));
    apiFetch.mockImplementationOnce(async (_url, options) => receipt(options, 4));
    const result = await enqueueServerFollowup(SID, 'later');
    const body = apiFetch.mock.calls[1][1].body;
    expect(body).toMatchObject({ expectedQueueRevision: 3, operation: { kind: 'enqueue', text: 'later', runWhenIdle: true } });
    expect(result).toEqual({ mode: 'running', queueRevision: 4 });
  });
  it('retries a revision conflict once with a new operation identity', async () => {
    apiFetch.mockResolvedValueOnce(response(empty));
    apiFetch.mockResolvedValueOnce(response({ error: 'stale' }, 409));
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 5 }));
    apiFetch.mockImplementationOnce(async (_url, options) => receipt(options, 6));
    await enqueueServerFollowup(SID, 'later');
    const [first, second] = [apiFetch.mock.calls[1][1].body, apiFetch.mock.calls[3][1].body];
    expect([second.expectedQueueRevision, second.operationId === first.operationId]).toEqual([5, false]);
  });
  it('throws a rejection without retrying twice and keeps the failure visible', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? response({ error: 'stale' }, 409) : response(empty));
    await expect(enqueueServerFollowup(SID, 'later')).rejects.toThrow(/stale|changed/i);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2);
  });
  it('confirms an uncertain send through the operation receipt before reporting failure', async () => {
    apiFetch.mockResolvedValueOnce(response(empty));
    let operationId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; throw new Error('socket closed'); });
    apiFetch.mockImplementationOnce(async url => {
      expect(url).toBe(`/api/structured/sessions/${SID}/queue/operations/${operationId}`);
      return response({ operationId, queueRevision: 4, itemId: apiFetch.mock.calls[1][1].body.operation.itemId, itemRevision: 1 });
    });
    expect(await enqueueServerFollowup(SID, 'later')).toEqual({ mode: 'running', queueRevision: 4 });
  });
  it('reports an unconfirmed send as possibly queued when no receipt exists', async () => {
    apiFetch.mockResolvedValueOnce(response(empty));
    apiFetch.mockRejectedValueOnce(new Error('socket closed'));
    apiFetch.mockResolvedValueOnce(response({}, 404));
    await expect(enqueueServerFollowup(SID, 'later')).rejects.toMatchObject({ uncertain: true });
  });
});
