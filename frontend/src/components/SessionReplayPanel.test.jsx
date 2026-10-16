import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionReplayPanel } from './SessionReplayPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  open() {} reset() {} dispose() {} write(_text, callback) { callback?.(); }
} }));
let recording;
const reply = data => ({ ok: true, json: async () => data });
beforeEach(() => {
  recording = { format: 'terminal-v4-session-recording', version: 1, id: 'replay-a', sessionId: 'terminal-a', kind: 'terminal', workspacePath: '/project', status: 'recording', startedAt: 100, events: [{ sourceSeq: 1, ts: 100, kind: 'terminal', text: 'hello' }, { sourceSeq: 2, ts: 200, kind: 'terminal', text: ' world' }] };
  apiFetch.mockImplementation(async (url, options) => {
    if (url.includes('/stop')) { recording = { ...recording, status: 'stopped', receipt: 'Recording stopped' }; return reply(recording); }
    if (options?.method === 'DELETE') return reply({ deleted: true });
    if (options?.method === 'POST') return reply(recording);
    if (url.includes('?')) return reply({ recordings: recording ? [recording] : [] });
    return reply(recording);
  });
});
describe('SessionReplayPanel', () => {
  it('requires output-recording consent before starting and opens a real replay', async () => {
    render(<SessionReplayPanel workspacePath="/project" sessionId="terminal-b" />);
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByRole('slider', { name: 'Replay position' });
    expect(apiFetch).toHaveBeenCalledWith('/api/recordings', expect.objectContaining({ method: 'POST', body: { sessionId: 'terminal-b', kind: 'terminal', workspacePath: '/project' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(await screen.findByRole('status')).toHaveTextContent('stopped: Recording stopped');
  });
  it('supports playback, speed, seek and deletion for selected recordings', async () => {
    render(<SessionReplayPanel workspacePath="/project" sessionId="terminal-a" />);
    await screen.findByRole('option', { name: /terminal · recording/ });
    fireEvent.change(screen.getByLabelText('Saved recording'), { target: { value: 'replay-a' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Play replay' }));
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '4' } });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '150' } });
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete recording' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/recordings/replay-a', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument());
  });
  it('clears a selected replay and consent when changing workspace', async () => {
    const { rerender } = render(<SessionReplayPanel workspacePath="/project" sessionId="terminal-a" />);
    await screen.findByRole('option', { name: /terminal · recording/ });
    fireEvent.change(screen.getByLabelText('Saved recording'), { target: { value: 'replay-a' } });
    await screen.findByRole('slider');
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<SessionReplayPanel workspacePath="/elsewhere" sessionId="terminal-b" />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('reports invalid recording formats instead of rendering untrusted events', async () => {
    render(<SessionReplayPanel workspacePath="/project" />);
    await screen.findByRole('option', { name: /terminal · recording/ });
    recording = { ...recording, version: 99 };
    fireEvent.change(screen.getByLabelText('Saved recording'), { target: { value: 'replay-a' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported recording format');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});
