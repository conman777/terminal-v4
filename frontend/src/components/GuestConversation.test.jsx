import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestConversation } from './GuestConversation';

const fetchMock = vi.fn();
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const grant = { credential: 'tv4share.cred', sessionId: 'ss-1', expiresAt: 4102444800, allowGuestMessages: false, title: 'Plan' };
const page = (patch = {}) => json({ generation: 'g1', cursor: 3, messages: [{ seq: 1, role: 'user', text: 'Hi <b>there</b>' }, { seq: 3, role: 'assistant', text: 'Hello' }], omitted: 0, caughtUp: true, title: 'Plan', allowGuestMessages: false, proposals: [], ...patch });

beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); history.replaceState(null, '', '/#share=abc.def'); });
afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

const open = async () => {
  render(<GuestConversation pollMs={50} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
  await screen.findByText('Hello');
};

describe('GuestConversation', () => {
  it('exchanges the fragment once, clears it, and renders messages as plain text', async () => {
    fetchMock.mockResolvedValueOnce(json(grant)).mockResolvedValue(page());
    await open();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'abc', secret: 'def', displayName: 'Guest' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', method: 'POST' });
    expect(window.location.hash).toBe('');
    expect(screen.getByText('Hi <b>there</b>')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tv4share.cred');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/structured-share/guest/ss-1/messages?after=0');
  });

  it('resumes from the returned cursor and does not duplicate messages', async () => {
    fetchMock.mockResolvedValueOnce(json(grant)).mockResolvedValueOnce(page()).mockResolvedValue(page({ messages: [] }));
    await open();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3));
    expect(fetchMock.mock.calls[2][0]).toContain('after=3');
    expect(fetchMock.mock.calls[2][0]).toContain('generation=g1');
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('stops polling and says sharing ended when access is revoked', async () => {
    fetchMock.mockResolvedValueOnce(json(grant)).mockResolvedValueOnce(page()).mockResolvedValue(json({ error: 'denied' }, 401));
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Sharing has ended/);
    const calls = fetchMock.mock.calls.length;
    await act(async () => { await new Promise(done => setTimeout(done, 200)); });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('explains a used or expired link without exposing details', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Share link is invalid, expired, or revoked' }, 401));
    render(<GuestConversation pollMs={50} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(await screen.findByText(/already used, or has expired/)).toBeInTheDocument();
  });

  it('offers suggestions only when the owner enabled them and says they need approval', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...grant, allowGuestMessages: true })).mockImplementation(async (url, options) => options?.method === 'POST' ? json({ id: 'p1', status: 'pending' }, 202) : page({ allowGuestMessages: true }));
    await open();
    fireEvent.change(screen.getByLabelText('Suggest a message to the owner'), { target: { value: 'please add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(await screen.findByText(/only if they approve it/)).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === 'POST' && o.body.includes('please'))[1].body)).toEqual({ text: 'please add tests' });
  });

  it('has no suggestion box on a read-only share', async () => {
    fetchMock.mockResolvedValueOnce(json(grant)).mockResolvedValue(page());
    await open();
    expect(screen.queryByLabelText('Suggest a message to the owner')).not.toBeInTheDocument();
  });

  it('reports an incomplete link', () => {
    history.replaceState(null, '', '/#share=broken');
    render(<GuestConversation />);
    expect(screen.getByRole('alert')).toHaveTextContent('incomplete');
    expect(screen.getByRole('button', { name: 'Open conversation' })).toBeDisabled();
  });
});
