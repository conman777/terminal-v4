import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionReplayPanel } from './SessionReplayPanel';
import { apiFetch } from '../utils/api';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const { terminals } = vi.hoisted(() => ({ terminals: [] }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor(options) { this.options = options; terminals.push(this); }
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
  it('shows recording loading before presenting an empty workspace', async () => {
    let finish;
    apiFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<SessionReplayPanel workspacePath="/project" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading recordings');
    expect(screen.queryByText('No recordings in this workspace.')).not.toBeInTheDocument();
    await act(async () => finish(reply({ recordings: [] })));
    expect(screen.getByText('No recordings in this workspace.')).toBeInTheDocument();
  });

  it('updates the replay terminal through its theme API when workspace colors change', async () => {
    render(<SessionReplayPanel workspacePath="/project" />);
    await screen.findByRole('option', { name: /terminal · recording/ });
    fireEvent.change(screen.getByLabelText('Saved recording'), { target: { value: 'replay-a' } });
    await screen.findByRole('slider');
    await waitFor(() => expect(terminals.length).toBeGreaterThan(0));
    const terminal = terminals.at(-1);
    const previous = document.documentElement.style.getPropertyValue('--text-primary');
    try {
      act(() => document.documentElement.style.setProperty('--text-primary', '#123456'));
      await waitFor(() => expect(terminal.options.theme.foreground).toBe('#123456'));
    } finally {
      act(() => document.documentElement.style.setProperty('--text-primary', previous));
    }
  });
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
  it.each([
    ['ss-agent-session', 'ss-agent-session'],
    ['structured:ss-legacy-session', 'ss-legacy-session'],
  ])('records structured session %s with its native ID', async (sessionId, nativeSessionId) => {
    render(<SessionReplayPanel workspacePath="/project" sessionId={sessionId} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/recordings', expect.objectContaining({
      method: 'POST', body: { sessionId: nativeSessionId, kind: 'structured', workspacePath: '/project' },
    })));
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

it('recovers a failed initial recording load with an explicit refresh', async () => {
  apiFetch.mockRejectedValueOnce(new Error('Recording list offline'));
  render(<SessionReplayPanel workspacePath="/project" />);
  await screen.findByText('Recording list offline');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh recordings' }));
  expect(await screen.findByRole('option', { name: /terminal · recording/ })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('marks failed polling as stale and clears only the recovered read error on success',async()=>{
 vi.useFakeTimers();
 try{
  apiFetch.mockRejectedValueOnce(new Error('Initial recording read offline'));
  await act(async()=>render(<SessionReplayPanel workspacePath="/project"/>));
  expect(screen.getByRole('alert')).toHaveTextContent('Initial recording read offline');
  await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  apiFetch.mockRejectedValueOnce(new Error('Recording poll disconnected'));
  await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('alert')).toHaveTextContent('Recording poll disconnected');
  expect(screen.getByText(/Recording list may be out of date/)).toBeInTheDocument();
  expect(screen.getByRole('option',{name:/terminal · recording/})).toBeInTheDocument();
  await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 }finally{vi.useRealTimers();}
});
