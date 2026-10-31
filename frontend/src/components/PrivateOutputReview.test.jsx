import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrivateOutputReview } from './PrivateOutputReview';
import { apiFetch } from '../utils/api';
import { setTokens, clearTokens } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const approval = { approvalId: 'approval-1', toolInput: { actionId: 'a'.repeat(64) } };
const token = '12345678-1234-4234-9234-123456789abc';
const response = value => ({ ok: true, json: async () => value });
const preview = { previewToken: token, output: { actionId: approval.toolInput.actionId, stdout: 'private output', stderr: '', stdoutTruncated: false, stderrTruncated: false } };

describe('PrivateOutputReview', () => {
  beforeEach(() => { vi.clearAllMocks(); setActiveEnvironment(null); setTokens('fixture-token', 'fixture-refresh'); });
  afterEach(() => { clearTokens(true); setActiveEnvironment(null); });

  it('shows output only after review and sends the exact token on explicit share', async () => {
    apiFetch.mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response({ status: 'accepted', approvalId: approval.approvalId, approved: true }));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    expect(screen.queryByText('private output')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByText('private output')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share output' }));
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/api/structured/sessions/session-1/private-output/approve', expect.objectContaining({ method: 'POST', body: { approvalId: approval.approvalId, actionId: approval.toolInput.actionId, previewToken: token } })));
  });

  it('identifies a reviewed recent-output window and omitted earlier text', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...preview, output: { ...preview.output, window: 'tail', stdoutTruncated: true } }));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByText('Most recent output; earlier output may be omitted.')).toBeVisible();
    expect(screen.getByText('Earlier output was omitted.')).toBeVisible();
    expect(screen.getByText('private output')).toBeVisible();
  });

  it('refuses a preview with an unknown output window', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...preview, output: { ...preview.output, window: 'unknown' } }));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Share output' })).not.toBeInTheDocument();
  });

  it('does not expose a delayed preview after changing session', async () => {
    let resolve;
    apiFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { rerender } = render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    rerender(<PrivateOutputReview sessionId="session-2" approval={approval} onReject={vi.fn()} />);
    resolve(response(preview));
    await waitFor(() => expect(screen.queryByText('private output')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Share output' })).not.toBeInTheDocument();
  });

  it('clears an open preview when the signed-in identity changes', async () => {
    apiFetch.mockResolvedValueOnce(response(preview));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByText('private output')).toBeInTheDocument();
    setTokens('different-user-token', 'different-user-refresh');
    await waitFor(() => expect(screen.queryByText('private output')).not.toBeInTheDocument());
  });

  it('clears the preview when switching environments', async () => {
    apiFetch.mockResolvedValueOnce(response(preview));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByText('private output')).toBeInTheDocument();
    setActiveEnvironment({ id: 'other-fixture', capabilities: { agentExecute: true } });
    await waitFor(() => expect(screen.queryByText('private output')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Share output' })).not.toBeInTheDocument();
  });

  it('does not allow sharing a preview for a different action', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...preview, output: { ...preview.output, actionId: 'b'.repeat(64) } }));
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Share output' })).not.toBeInTheDocument();
  });

  it('warns when a share response is lost and retains the same token for an explicit retry', async () => {
    apiFetch.mockResolvedValueOnce(response(preview)).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: false, status: 409 });
    render(<PrivateOutputReview sessionId="session-1" approval={approval} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
    expect(await screen.findByText('private output')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share output' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/may have been shared/i);
    expect(screen.getByRole('button', { name: 'Check decision' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check decision' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('alert')).toHaveTextContent(/may have been shared/i);
    expect(screen.getByRole('button', { name: 'Check decision' })).toBeEnabled();
  });
});
