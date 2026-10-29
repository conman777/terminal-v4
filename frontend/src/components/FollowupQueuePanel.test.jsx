import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupQueuePanel } from './FollowupQueuePanel';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const SID = 'ss-00000000000000000000000000000001';
const A = '00000000-0000-4000-8000-000000000010';
const B = '00000000-0000-4000-8000-000000000011';
const empty = { revision: 0, mode: 'held', holdReason: 'new', items: [], order: [] };
const first = { itemId: A, revision: 1, text: 'first', inputRequestId: '00000000-0000-4000-8000-000000000020', state: 'pending', createdAt: 1, updatedAt: 1, acceptedReceipt: null };
const second = { ...first, itemId: B, text: 'second', inputRequestId: '00000000-0000-4000-8000-000000000021' };
const running = { revision: 2, mode: 'running', holdReason: null, items: [first, second], order: [A, B] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const queue = () => fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
const record = () => Object.keys(localStorage).filter(key => key.includes('followupQueuePanel')).map(key => JSON.parse(localStorage.getItem(key)))[0];
const setup = async (snapshot = empty, props = {}) => {
  apiFetch.mockResolvedValue(response(snapshot));
  const view = render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={0} {...props} />);
  await screen.findByRole('button', { name: 'Queue message' });
  return view;
};
const nextMutation = next => {
  apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: next.revision, itemId: options.body.operation.itemId ?? null, itemRevision: options.body.operation.itemId ? 2 : null }));
  apiFetch.mockResolvedValueOnce(response(next));
};

beforeEach(() => { vi.restoreAllMocks(); apiFetch.mockReset(); localStorage.clear(); setEnvironmentIdentity('queue-owner', window.location.origin); setActiveEnvironment(null); });

describe('FollowupQueuePanel', () => {
  it('loads only a snapshot and makes restart hold visible without resuming work', async () => {
    await setup({ ...running, mode: 'held', holdReason: 'restart' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe(`/api/structured/sessions/${SID}/queue`);
    expect(screen.getByText(/held after.*restart/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeEnabled();
    expect(apiFetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it('explains how to recover a held message without assuming it was unsent', async () => {
    await setup({ ...running, mode: 'held', holdReason: 'dispatch_error' });
    expect(screen.getByText(/check the conversation first/i)).toHaveTextContent(/copy it, remove it from the queue, then send it/i);
    expect(screen.getByRole('button', { name: 'Remove message 1' })).toBeEnabled();
  });

  it('persists exact mutation identity before queueing and clears only its confirmed draft', async () => {
    await setup(); change('Queued message', 'later task');
    let observed;
    apiFetch.mockImplementationOnce(async (_url, options) => {
      observed = record();
      expect(observed.pending.mutation).toEqual(options.body);
      return response({ operationId: options.body.operationId, queueRevision: 1, itemId: options.body.operation.itemId, itemRevision: 1 });
    });
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 1 }));
    queue();
    await waitFor(() => expect(screen.getByLabelText('Queued message')).toHaveValue(''));
    expect(observed.pending.mutation.operation).toMatchObject({ kind: 'enqueue', text: 'later task', runWhenIdle: true });
    expect(observed.pending.mutation.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record().pending).toBeNull();
  });

  it('keeps text typed during an accepted queue request', async () => {
    await setup(); change('Queued message', 'submitted task');
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    queue(); const mutation = apiFetch.mock.calls[1][1].body;
    change('Queued message', 'new task typed meanwhile');
    apiFetch.mockResolvedValueOnce(response(empty));
    await act(async () => resolve(response({ operationId: mutation.operationId, queueRevision: 1, itemId: mutation.operation.itemId, itemRevision: 1 })));
    expect(screen.getByLabelText('Queued message')).toHaveValue('new task typed meanwhile');
  });

  it('does not clear a newer draft revision even if its text returns to the submitted value', async () => {
    await setup(); change('Queued message', 'same visible text');
    let resolve; apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    queue(); const mutation = apiFetch.mock.calls[1][1].body;
    change('Queued message', 'temporary edit'); change('Queued message', 'same visible text');
    apiFetch.mockResolvedValueOnce(response(empty));
    await act(async () => resolve(response({ operationId: mutation.operationId, queueRevision: 1, itemId: mutation.operation.itemId, itemRevision: 1 })));
    expect(screen.getByLabelText('Queued message')).toHaveValue('same visible text');
  });

  it('edits an item in a separate buffer and preserves the new-message draft', async () => {
    await setup(running); change('Queued message', 'main draft stays');
    fireEvent.click(screen.getByRole('button', { name: 'Edit message 1' }));
    change('Edit queued message', 'edited first');
    nextMutation({ ...running, revision: 3, items: [{ ...first, text: 'edited first', revision: 2 }, second] });
    fireEvent.click(screen.getByRole('button', { name: 'Save queued edit' }));
    await screen.findByText('edited first');
    expect(screen.getByLabelText('Queued message')).toHaveValue('main draft stays');
    expect(apiFetch.mock.calls[1][1].body).toMatchObject({ expectedQueueRevision: 2, operation: { kind: 'edit', itemId: A, expectedItemRevision: 1, text: 'edited first' } });
  });

  it('promotes and reorders existing IDs without putting queue text into the composer', async () => {
    await setup(running); change('Queued message', 'untouched draft');
    nextMutation({ ...running, revision: 3, order: [B, A] });
    fireEvent.click(screen.getByRole('button', { name: 'Promote message 2' }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => options?.body?.operation?.kind === 'promote')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move message 1 down' })).toBeEnabled());
    expect(screen.getByLabelText('Queued message')).toHaveValue('untouched draft');
    nextMutation({ ...running, revision: 4, order: [A, B] });
    fireEvent.click(screen.getByRole('button', { name: 'Move message 1 down' }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => options?.body?.operation?.kind === 'reorder')).toBe(true));
    const mutation = apiFetch.mock.calls.find(([, options]) => options?.body?.operation?.kind === 'reorder')[1].body;
    expect(mutation.operation.itemIds).toEqual([A, B]);
    expect(screen.getByLabelText('Queued message')).toHaveValue('untouched draft');
  });

  it('pauses, resumes, and removes only through explicit user actions', async () => {
    await setup(running);
    nextMutation({ ...running, revision: 3, mode: 'held', holdReason: 'manual' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause queue' }));
    await screen.findByRole('button', { name: 'Resume queue' });
    nextMutation({ ...running, revision: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    await screen.findByRole('button', { name: 'Pause queue' });
    nextMutation({ ...running, revision: 5, items: [{ ...first, state: 'removed', revision: 2 }, second], order: [B] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove message 1' }));
    await waitFor(() => expect(screen.queryByText('first')).not.toBeInTheDocument());
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => options.body.operation.kind)).toEqual(['pause', 'resume', 'remove']);
  });

  it('retains a rejected draft and refreshes changed host state without automatic retry', async () => {
    await setup(); change('Queued message', 'keep this');
    apiFetch.mockResolvedValueOnce(response({ error: 'Queue changed; reload before applying.' }, 409));
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 2 }));
    queue();
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue changed');
    expect(screen.getByLabelText('Queued message')).toHaveValue('keep this');
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(record().pending).toBeNull();
  });

  it('treats a known non-JSON rejection as rejected instead of an indefinitely uncertain mutation', async () => {
    await setup(); change('Queued message', 'rejected payload');
    apiFetch.mockResolvedValueOnce({ ok: false, status: 413, json: async () => { throw new Error('not JSON'); } });
    apiFetch.mockResolvedValueOnce(response(empty)); queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/413/);
    expect(screen.getByLabelText('Queued message')).toHaveValue('rejected payload');
    expect(record().pending).toBeNull();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('looks up a lost response and accepts the durable operation receipt without a second POST', async () => {
    await setup(); change('Queued message', 'only once'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; throw new Error('connection lost'); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response(empty)); queue();
    await waitFor(() => expect(screen.getByLabelText('Queued message')).toHaveValue(''));
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(apiFetch.mock.calls[2][0]).toBe(`/api/structured/sessions/${SID}/queue/operations/${operationId}`);
  });

  it('explains how to wake an idle running queue after a saved uncertain action', async () => {
    await setup(); change('Queued message', 'saved work'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; return response({ error: 'Queue operation may have been saved' }, 503); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 1, mode: 'running', holdReason: null }));
    queue();
    expect(await screen.findByText(/use Wake queue if it stays idle/i)).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(record().pending).toBeNull();
  });

  it('retains a saved action wake reminder across remount and wakes using a new explicit operation', async () => {
    const view = await setup(); change('Queued message', 'saved for recovery');
    let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; return response({ error: 'Queue operation may have been saved' }, 503); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    const runningOne = () => ({ revision: 1, mode: 'running', holdReason: null, items: [{ ...first, itemId, text: 'saved for recovery' }], order: [itemId] });
    apiFetch.mockImplementationOnce(async () => response(runningOne()));
    queue();
    await screen.findByRole('button', { name: 'Wake queue' });
    expect(record().wakeRecovery).toEqual({ operationId });
    view.unmount();

    apiFetch.mockResolvedValueOnce(response(runningOne()));
    render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={0} />);
    await screen.findByRole('button', { name: 'Wake queue' });
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    apiFetch.mockImplementationOnce(async (_url, options) => {
      expect(options.body.operation).toEqual({ kind: 'wake' });
      expect(options.body.operationId).not.toBe(operationId);
      return response({ operationId: options.body.operationId, queueRevision: 2, itemId: null, itemRevision: null });
    });
    apiFetch.mockResolvedValueOnce(response({ ...runningOne(), revision: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    await waitFor(() => expect(record().wakeRecovery).toBeNull());
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2);
  });

  it('keeps a recovered wake reminder but never wakes a manually held queue', async () => {
    await setup(); change('Queued message', 'held recovery'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; throw new Error('lost reply'); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 1, mode: 'held', holdReason: 'manual' }));
    queue();
    expect(await screen.findByRole('button', { name: 'Wake queue' })).toBeDisabled();
    expect(screen.getByText(/held.*manually sending/i)).toBeInTheDocument();
    expect(record().wakeRecovery).toEqual({ operationId });
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('restores a recovered reminder only for the same account after a sign-in change', async () => {
    await setup(); change('Queued message', 'account-scoped recovery'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; return response({ error: 'Queue operation may have been saved' }, 503); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response({ ...empty, revision: 1 }));
    queue();
    await screen.findByRole('button', { name: 'Dismiss wake reminder' });
    await act(async () => setEnvironmentIdentity('other-account', window.location.origin));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss wake reminder' })).not.toBeInTheDocument());
    await act(async () => setEnvironmentIdentity('queue-owner', window.location.origin));
    expect(await screen.findByRole('button', { name: 'Dismiss wake reminder' })).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('keeps the exact wake identity when wake confirmation and receipt lookup are unavailable', async () => {
    await setup(); change('Queued message', 'saved before wake'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; return response({ error: 'Queue operation may have been saved' }, 503); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    apiFetch.mockImplementationOnce(async () => response({ revision: 1, mode: 'running', holdReason: null, items: [{ ...first, itemId, text: 'saved before wake' }], order: [itemId] }));
    queue();
    await screen.findByRole('button', { name: 'Wake queue' });
    apiFetch.mockResolvedValueOnce(response({ error: 'Queue wake may have been saved' }, 503));
    apiFetch.mockResolvedValueOnce(response({ error: 'Sign in again' }, 401));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/exact identity and draft were kept/i);
    const saved = record();
    expect(saved.wakeRecovery).toEqual({ operationId });
    expect(saved.pending.mutation.operation).toEqual({ kind: 'wake' });
    expect(saved.pending.mutation.operationId).not.toBe(operationId);
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled();
  });

  it('retains the reminder and explains the fallback when an older host rejects Wake', async () => {
    await setup(); change('Queued message', 'saved on an older server'); let operationId; let itemId;
    apiFetch.mockImplementationOnce(async (_url, options) => { operationId = options.body.operationId; itemId = options.body.operation.itemId; return response({ error: 'Queue operation may have been saved' }, 503); });
    apiFetch.mockImplementationOnce(async () => response({ operationId, queueRevision: 1, itemId, itemRevision: 1 }));
    const current = () => ({ revision: 1, mode: 'running', holdReason: null, items: [{ ...first, itemId, text: 'saved on an older server' }], order: [itemId] });
    apiFetch.mockImplementationOnce(async () => response(current()));
    queue();
    await screen.findByRole('button', { name: 'Wake queue' });
    apiFetch.mockResolvedValueOnce(response({ error: 'Unknown operation' }, 400));
    apiFetch.mockResolvedValueOnce(response(current()));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check the conversation before manually sending/i);
    expect(record().pending).toBeNull();
    expect(record().wakeRecovery).toEqual({ operationId });
    expect(screen.getByRole('button', { name: 'Wake queue' })).toBeEnabled();
  });

  it('offers another explicit wake if the queue remains idle after a confirmed wake', async () => {
    await setup(running);
    const originalOrder = [...running.order];
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 3, itemId: null, itemRevision: null }));
    apiFetch.mockResolvedValueOnce(response({ ...running, revision: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    expect(await screen.findByText('Queue processing requested.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wake queue' })).toBeEnabled();
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 4, itemId: null, itemRevision: null }));
    apiFetch.mockResolvedValueOnce(response({ ...running, revision: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    await waitFor(() => expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2));
    const posts = apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts.map(([, options]) => options.body.operation)).toEqual([{ kind: 'wake' }, { kind: 'wake' }]);
    expect(posts[0][1].body.operationId).not.toBe(posts[1][1].body.operationId);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(originalOrder).toEqual([A, B]);
  });

  it('explains when the server holds a wake for unverified queued work', async () => {
    await setup(running);
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 3, itemId: null, itemRevision: null }));
    apiFetch.mockResolvedValueOnce(response({ ...running, revision: 3, mode: 'held', holdReason: 'dispatch_error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wake queue' }));
    expect(await screen.findByText(/Queue was held for review/i)).toHaveTextContent(/before manually sending unsent work/i);
    expect(screen.queryByRole('button', { name: 'Wake queue' })).not.toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('keeps the exact operation and draft when uncertain acceptance cannot be looked up after sign-out', async () => {
    await setup(); change('Queued message', 'possibly saved');
    apiFetch.mockResolvedValueOnce(response({ error: 'Queue operation may have been saved' }, 503));
    apiFetch.mockResolvedValueOnce(response({ error: 'Sign in again' }, 401));
    queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/exact identity and draft were kept/i);
    expect(record().pending.mutation.operation.text).toBe('possibly saved');
    expect(screen.getByLabelText('Queued message')).toHaveValue('possibly saved');
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('retains uncertain identity through unmount and restores by lookup without a repeated enqueue', async () => {
    const view = await setup(); change('Queued message', 'uncertain work');
    apiFetch.mockRejectedValueOnce(new Error('lost reply'));
    apiFetch.mockResolvedValueOnce(response({ error: 'not yet known' }, 404)); queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    const saved = record(); expect(saved.pending.mutation.operation.text).toBe('uncertain work');
    view.unmount(); apiFetch.mockResolvedValue(response(empty));
    apiFetch.mockResolvedValueOnce(response(empty));
    apiFetch.mockResolvedValueOnce(response({ operationId: saved.pending.mutation.operationId, queueRevision: 1, itemId: saved.pending.mutation.operation.itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response(empty));
    render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={0} />);
    await waitFor(() => expect(screen.getByLabelText('Queued message')).toHaveValue(''));
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(record().pending).toBeNull();
  });

  it('explicit retry reuses the frozen operation after an uncertain404', async () => {
    await setup(); change('Queued message', 'same operation');
    apiFetch.mockRejectedValueOnce(new Error('lost reply')); apiFetch.mockResolvedValueOnce(response({}, 404)); queue();
    await screen.findByRole('alert'); const original = record().pending.mutation;
    apiFetch.mockResolvedValueOnce(response({}, 404));
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 1, itemId: options.body.operation.itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response(empty));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same queue action' }));
    await waitFor(() => expect(record().pending).toBeNull());
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')[1][1].body).toEqual(original);
  });

  it('does not clear a draft on a receipt for another item identity', async () => {
    await setup(); change('Queued message', 'keep identity');
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 1, itemId: A, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response({}, 404)); queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(screen.getByLabelText('Queued message')).toHaveValue('keep identity');
    expect(record().pending).not.toBeNull();
  });

  it('reports a local storage failure after host acceptance while preserving the durable pending identity', async () => {
    await setup(); change('Queued message', 'host confirmed');
    let storageSpy;
    apiFetch.mockImplementationOnce(async (_url, options) => {
      storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disk full'); });
      return response({ operationId: options.body.operationId, queueRevision: 1, itemId: options.body.operation.itemId, itemRevision: 1 });
    });
    apiFetch.mockResolvedValueOnce(response(empty)); queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved on this device/i);
    expect(record().pending).not.toBeNull();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    storageSpy.mockRestore();
  });

  it('does not send an action whose exact retry identity cannot be stored', async () => {
    await setup(); change('Queued message', 'keep bytes locally');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved on this device/i);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    expect(screen.getByLabelText('Queued message')).toHaveValue('keep bytes locally'); setItem.mockRestore();
  });

  it('aborts on session switch and does not apply the old queue to a new session', async () => {
    let resolve; apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={0} />);
    const signal = apiFetch.mock.calls[0][1].signal;
    apiFetch.mockResolvedValue(response(empty));
    view.rerender(<FollowupQueuePanel sessionId="ss-00000000000000000000000000000002" pollIntervalMs={0} />);
    await screen.findByRole('button', { name: 'Queue message' }); expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(running))); expect(screen.queryByText('first')).not.toBeInTheDocument();
  });

  it('isolates saved queue drafts by account and restores the same account without sending', async () => {
    const view = await setup(); change('Queued message', 'account A draft');
    await act(async () => setEnvironmentIdentity('other-account', window.location.origin));
    await waitFor(() => expect(screen.getByLabelText('Queued message')).toHaveValue(''));
    change('Queued message', 'account B draft');
    await act(async () => setEnvironmentIdentity('queue-owner', window.location.origin));
    await waitFor(() => expect(screen.getByLabelText('Queued message')).toHaveValue('account A draft'));
    expect(apiFetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true); view.unmount();
  });

  it('rejects malformed host snapshots and UTF8 oversized drafts before mutation', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...empty, order: [A] }));
    render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid queue/i);
    expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response(empty)); fireEvent.click(screen.getByRole('button', { name: 'Reload queue' }));
    await screen.findByRole('button', { name: 'Queue message' }); change('Queued message', '€'.repeat(40_000)); queue();
    expect(await screen.findByRole('alert')).toHaveTextContent(/100,000.*bytes/i);
    expect(apiFetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });
  it.each([400, 401, 403, 404, 409, 413, 422])('retains an earlier uncertain operation when its retry is rejected (%s)', async status => {
    await setup(); change('Queued message', 'an earlier authorized request may still commit');
    apiFetch.mockRejectedValueOnce(new Error('lost original reply'));
    apiFetch.mockResolvedValueOnce(response({}, 404)); queue();
    await screen.findByRole('alert');
    const original = record().pending.mutation;
    apiFetch.mockResolvedValueOnce(response({}, 404));
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic retry rejected' }, status));
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic receipt lookup unavailable' }, status));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same queue action' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be confirmed/i));
    expect(record().pending?.mutation).toEqual(original);
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled();
    expect(screen.getByLabelText('Queued message')).toHaveValue(original.operation.text);
    apiFetch.mockResolvedValueOnce(response({ operationId: original.operationId, queueRevision: 1, itemId: original.operation.itemId, itemRevision: 1 }));
    apiFetch.mockResolvedValueOnce(response(empty));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same queue action' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry same queue action' }));
    await waitFor(() => expect(record().pending).toBeNull());
    expect(screen.getByLabelText('Queued message')).toHaveValue('');
    const posts = apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1][1].body).toEqual(original);
  });
});

describe('FollowupQueuePanel shared queue controls', () => {
  const post = () => apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => options.body);
  const hold = () => { let release; const wait = new Promise(done => { release = done; }); return { wait, release }; };

  it('shows a Saving row immediately and rolls it back with the host error on a 409', async () => {
    await setup(running); change('Queued message', 'optimistic task');
    const pending = hold(); apiFetch.mockImplementationOnce(() => pending.wait);
    queue();
    const row = (await screen.findByText('optimistic task', { selector: 'p' })).closest('li');
    expect(row).toHaveTextContent('Saving');
    apiFetch.mockResolvedValueOnce(response(running));
    await act(async () => pending.release(response({ error: 'Queue changed; reload before applying.' }, 409)));
    await waitFor(() => expect(screen.queryByText('optimistic task', { selector: 'p' })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Queue changed');
    expect(screen.getByLabelText('Queued message')).toHaveValue('optimistic task');
  });

  it('keeps a confirmed row without a flash back to the old queue and drops the Saving label', async () => {
    await setup(running); change('Queued message', 'confirmed task');
    const added = { ...first, itemId: '00000000-0000-4000-8000-000000000012', inputRequestId: '00000000-0000-4000-8000-000000000022', text: 'confirmed task', revision: 3 };
    const next = { ...running, revision: 3, items: [first, second, added], order: [A, B, added.itemId] };
    apiFetch.mockImplementationOnce(async (_url, options) => response({ operationId: options.body.operationId, queueRevision: 3, itemId: options.body.operation.itemId, itemRevision: 3 }));
    apiFetch.mockResolvedValueOnce(response(next));
    queue();
    await screen.findByText('confirmed task', { selector: 'p' });
    await waitFor(() => expect(screen.getByText('confirmed task', { selector: 'p' }).closest('li')).not.toHaveTextContent('Saving'));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('hides a removed row while saving and restores it when the removal is rejected', async () => {
    await setup(running);
    const pending = hold(); apiFetch.mockImplementationOnce(() => pending.wait);
    fireEvent.click(screen.getByRole('button', { name: 'Remove message 1' }));
    await waitFor(() => expect(screen.queryByText('first', { selector: 'p' })).not.toBeInTheDocument());
    apiFetch.mockResolvedValueOnce(response(running));
    await act(async () => pending.release(response({ error: 'Message changed' }, 409)));
    expect(await screen.findByText('first', { selector: 'p' })).toBeInTheDocument();
  });

  it('reorders with arrow keys on the drag handle', async () => {
    await setup(running);
    nextMutation({ ...running, revision: 3, order: [B, A] });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder message 1' }), { key: 'ArrowDown' });
    await waitFor(() => expect(post().map(body => body.operation)).toEqual([{ kind: 'reorder', itemIds: [B, A] }]));
  });

  it('does not move the first message up or the last message down from the keyboard', async () => {
    await setup(running);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder message 1' }), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder message 2' }), { key: 'ArrowDown' });
    expect(post()).toEqual([]);
  });

  it('reorders by dragging a row onto another row', async () => {
    await setup(running);
    nextMutation({ ...running, revision: 3, order: [B, A] });
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[0]); fireEvent.dragOver(rows[1]); fireEvent.drop(rows[1]);
    await waitFor(() => expect(post().map(body => body.operation)).toEqual([{ kind: 'reorder', itemIds: [B, A] }]));
  });

  it('labels promote as running next and explains why send now is unavailable', async () => {
    await setup(running);
    expect(screen.getAllByRole('button', { name: /^Promote message/ })[0]).toHaveTextContent('Run next');
    expect(screen.getByText(/Send now and steering are unavailable/i)).toBeInTheDocument();
  });

  it('shows an update made on another device and keeps stale polls from replacing newer state', async () => {
    apiFetch.mockResolvedValueOnce(response(running));
    render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={500} />);
    await screen.findByText('first', { selector: 'p' });
    const added = { ...first, itemId: '00000000-0000-4000-8000-000000000012', inputRequestId: '00000000-0000-4000-8000-000000000022', text: 'from phone', revision: 3 };
    apiFetch.mockResolvedValueOnce(response({ ...running, revision: 3, items: [first, second, added], order: [A, B, added.itemId] }));
    expect(await screen.findByText('from phone', { selector: 'p' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/updated from another device/i)).toBeInTheDocument();
    const calls = apiFetch.mock.calls.length;
    apiFetch.mockResolvedValue(response({ ...running, revision: 2, items: [{ ...first, text: 'stale text' }, second], order: [A, B] }));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(calls), { timeout: 3000 });
    expect(screen.queryByText('stale text', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByText('from phone', { selector: 'p' })).toBeInTheDocument();
  });

  it('warns when the message being edited changed on another device', async () => {
    apiFetch.mockResolvedValueOnce(response(running));
    render(<FollowupQueuePanel sessionId={SID} pollIntervalMs={500} />);
    await screen.findByText('first', { selector: 'p' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit message 1' }));
    change('Edit queued message', 'my edit');
    apiFetch.mockResolvedValue(response({ ...running, revision: 3, items: [{ ...first, text: 'edited elsewhere', revision: 2 }, second] }));
    expect(await screen.findByText(/changed on another device/i, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Edit queued message')).toHaveValue('my edit');
  });
});
