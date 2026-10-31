import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSharePanel } from './ConversationSharePanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const SID = 'ss-00000000000000000000000000000001';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const share = (patch = {}) => ({ id: 'share-1', createdAt: 1, expiresAt: 4102444800, redeemedAt: null, guestName: null, lastSeenAt: null, revokedAt: null, allowGuestMessages: false, state: 'unredeemed', proposals: [], ...patch });
const listing = (shares = [], audit = []) => response({ shares, audit });
const posts = () => apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');

beforeEach(() => { apiFetch.mockReset(); setActiveEnvironment(null); });

describe('ConversationSharePanel', () => {
  it('states the permission contract before anything is shared', async () => {
    apiFetch.mockResolvedValue(listing());
    render(<ConversationSharePanel sessionId={SID} />);
    await screen.findByText(/No share links for this conversation/);
    const contract = screen.getByRole('note');
    expect(contract).toHaveTextContent(/read this one conversation/i);
    expect(contract).toHaveTextContent(/cannot see tool output, approvals, files, other conversations or terminals/i);
    expect(contract).toHaveTextContent(/works once/i);
    expect(posts()).toHaveLength(0);
  });

  it('creates a 24 hour read-only link whose secret lives only in the fragment', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? response({ id: 'share-1', secret: 'secret-1', expiresAt: 4102444800 }) : listing());
    render(<ConversationSharePanel sessionId={SID} />);
    await screen.findByText(/No share links/);
    fireEvent.click(screen.getByRole('button', { name: 'Create read-only link' }));
    const link = await screen.findByLabelText('Share link');
    expect(link.value).toBe(`${window.location.origin}/#share=share-1.secret-1`);
    expect(posts()[0]).toEqual([`/api/structured/sessions/${SID}/shares`, expect.objectContaining({ home: true, method: 'POST', body: { expiresInSeconds: 86400, allowGuestMessages: false } })]);
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('only allows guest messages after an explicit opt-in that explains owner approval', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? response({ id: 'share-2', secret: 's', expiresAt: 4102444800 }) : listing());
    render(<ConversationSharePanel sessionId={SID} />);
    await screen.findByText(/No share links/);
    fireEvent.click(screen.getByLabelText(/let the guest suggest messages/i));
    expect(screen.getByText(/you approve each one and send it yourself/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Link expires after'), { target: { value: '3600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create read-only link' }));
    await screen.findByLabelText('Share link');
    expect(posts()[0][1].body).toEqual({ expiresInSeconds: 3600, allowGuestMessages: true });
  });

  it('stops sharing immediately and refreshes the list', async () => {
    let calls = 0;
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'DELETE') return response(null, 204);
      calls += 1;
      return listing([share(calls > 1 ? { state: 'revoked', revokedAt: 5 } : { state: 'active', redeemedAt: 2, guestName: 'Pat' })]);
    });
    render(<ConversationSharePanel sessionId={SID} />);
    await screen.findByText('Pat');
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing share-1' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/structured/sessions/${SID}/shares/share-1`, expect.objectContaining({ home: true, method: 'DELETE' })));
    expect(await screen.findByText(/Sharing stopped/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop sharing share-1' })).not.toBeInTheDocument();
  });

  it('puts an approved guest message into the composer without sending it and dismisses others', async () => {
    const proposals = [{ id: 'p1', guestName: 'Pat', text: 'please run tests', createdAt: 3, status: 'pending' }, { id: 'p2', guestName: 'Pat', text: 'delete everything', createdAt: 4, status: 'pending' }];
    apiFetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return response({ id: url.split('/').pop(), status: options.body.decision === 'approve' ? 'approved' : 'dismissed', text: options.body.decision === 'approve' ? 'please run tests' : null });
      return listing([share({ state: 'active', redeemedAt: 2, guestName: 'Pat', allowGuestMessages: true, proposals })]);
    });
    const onInsertPrompt = vi.fn();
    render(<ConversationSharePanel sessionId={SID} onInsertPrompt={onInsertPrompt} />);
    await screen.findByText('please run tests');
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add to composer: please run tests' }));
    await waitFor(() => expect(onInsertPrompt).toHaveBeenCalledWith('please run tests'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: delete everything' }));
    await waitFor(() => expect(posts().map(([url, options]) => [url.split('/').slice(-2).join('/'), options.body.decision])).toEqual([['proposals/p1', 'approve'], ['proposals/p2', 'dismiss']]));
    expect(onInsertPrompt).toHaveBeenCalledTimes(1);
  });

  it('recovers an approved suggestion after its response is lost, without inserting it automatically', async () => {
    let accepted = false;
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { accepted = true; throw new Error('Connection lost'); }
      return listing([share({ allowGuestMessages: true, proposals: [{ id: 'p1', guestName: 'Pat', text: 'keep my draft', createdAt: 3, status: accepted ? 'approved' : 'pending' }] })]);
    });
    const onInsertPrompt = vi.fn();
    render(<ConversationSharePanel sessionId={SID} onInsertPrompt={onInsertPrompt} pollMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and add to composer: keep my draft' }));
    const recover = await screen.findByRole('button', { name: 'Add approved suggestion to composer: keep my draft' });
    expect(onInsertPrompt).not.toHaveBeenCalled();
    fireEvent.click(recover);
    expect(onInsertPrompt).toHaveBeenCalledExactlyOnceWith('keep my draft');
    expect(posts()).toHaveLength(1);
  });

  it('does not insert an approval after the owner switches conversations', async () => {
    let resolveApproval;
    apiFetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return new Promise(resolve => { resolveApproval = resolve; });
      return listing(url.includes(SID) ? [share({ proposals: [{ id: 'p1', guestName: 'Pat', text: 'old conversation', status: 'pending' }] })] : []);
    });
    const onInsertPrompt = vi.fn();
    const view = render(<ConversationSharePanel sessionId={SID} onInsertPrompt={onInsertPrompt} pollMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and add to composer: old conversation' }));
    const nextId = 'ss-00000000000000000000000000000002';
    view.rerender(<ConversationSharePanel sessionId={nextId} onInsertPrompt={onInsertPrompt} pollMs={0} />);
    await screen.findByText(/No share links/);
    await act(async () => resolveApproval(response({ status: 'approved', text: 'old conversation' })));
    expect(onInsertPrompt).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'owner', 'environment', 'unmount', 'conversation-return', 'owner-return', 'environment-return'])('does not show a late share link after %s changes', async change => {
    setUser({ id: 'share-owner-a' });
    let finish;
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST'
      ? new Promise(resolve => { finish = resolve; })
      : listing());
    const view = render(<ConversationSharePanel sessionId={SID} pollMs={0} />);
    await screen.findByText(/No share links/);
    fireEvent.click(screen.getByRole('button', { name: 'Create read-only link' }));
    if (change === 'conversation') view.rerender(<ConversationSharePanel sessionId="another-conversation" pollMs={0} />);
    if (change === 'owner') act(() => setUser({ id: 'share-owner-b' }));
    if (change === 'environment') act(() => setActiveEnvironment({ id: 'remote-x', baseUrl: 'https://example.invalid' }));
    if (change === 'conversation-return') {
      view.rerender(<ConversationSharePanel sessionId="another-conversation" pollMs={0} />);
      view.rerender(<ConversationSharePanel sessionId={SID} pollMs={0} />);
    }
    if (change === 'owner-return') act(() => { setUser({ id: 'share-owner-b' }); setUser({ id: 'share-owner-a' }); });
    if (change === 'environment-return') act(() => { setActiveEnvironment({ id: 'remote-x', baseUrl: 'https://example.invalid' }); setActiveEnvironment(null); });
    if (change === 'unmount') view.unmount();
    await act(async () => finish(response({ id: 'old-share', secret: 'old-secret' })));
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
    setUser(null);
  });

  it('is disabled with an explanation when viewing a remote environment', async () => {
    setActiveEnvironment({ id: 'remote-x', name: 'Remote', baseUrl: 'https://remote.example.invalid' });
    render(<ConversationSharePanel sessionId={SID} />);
    expect(screen.getByRole('status')).toHaveTextContent(/directly on the owning server/);
    expect(screen.getByRole('button', { name: 'Create read-only link' })).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the owner audit trail', async () => {
    apiFetch.mockResolvedValue(listing([], [{ shareId: 'share-1', at: 10, kind: 'exchange_denied', detail: '' }, { shareId: 'share-1', at: 9, kind: 'redeemed', detail: 'Pat' }]));
    render(<ConversationSharePanel sessionId={SID} />);
    expect(await screen.findByText(/Link reuse or invalid attempt blocked/)).toBeInTheDocument();
    expect(screen.getByText(/Guest joined: Pat/)).toBeInTheDocument();
  });

  it('reports failures and keeps the link secret out of the list', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? response({ error: 'Revoke an existing share link before creating another' }, 400) : listing());
    render(<ConversationSharePanel sessionId={SID} />);
    await screen.findByText(/No share links/);
    fireEvent.click(screen.getByRole('button', { name: 'Create read-only link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revoke an existing share link');
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });
});
