import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { DesktopConversationView } from './DesktopConversationView';

vi.mock('../utils/api', async original => ({ ...(await original()), apiFetch: vi.fn(), apiGet: vi.fn().mockResolvedValue({}) }));

beforeEach(() => { localStorage.clear(); setUser({ id: 'file-owner' }); vi.clearAllMocks(); });

describe('conversation file references', () => {
  it('opens a scoped file location from a grouped tool result', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 2, totalLines: 2,
      lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target line', truncated: false }] }) });
    render(<DesktopConversationView mode="structured" sessionId="ss-one" workspacePath="/work/project" connectionState="online" structuredToolCalls={[]} structuredMessages={[
      { role: 'user', messageId: 'prompt', content: 'Check files' },
      { role: 'tool', toolCallId: 'task-one', toolName: 'Bash', toolInput: { command: 'check' }, result: 'src/app.js:2:7' },
      { role: 'tool', toolCallId: 'task-two', toolName: 'Bash', toolInput: { command: 'check other' }, result: 'other output' },
      { role: 'assistant', messageId: 'answer', content: 'Done' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    fireEvent.click(screen.getByText(/Ran 2 commands/).closest('summary'));
    fireEvent.click(await screen.findByRole('button', { name: /Run command.*checkCompleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.js:2:7 at line 2' }));
    expect(await screen.findByText('target line')).toBeVisible();
  });

  it('opens an owned file preview and closes it when the thread changes', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 2, totalLines: 2,
      lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target line', truncated: false }] }) });
    const props = { mode: 'structured', sessionId: 'ss-one', workspacePath: '/work/project', structuredMessages: [
      { role: 'assistant', messageId: 'answer', content: 'Review [source](/work/project/src/app.js:2).' },
    ], structuredToolCalls: [], connectionState: 'online' };
    const view = render(<DesktopConversationView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source at line 2' }));
    expect(await screen.findByText('target line')).toBeVisible();
    view.rerender(<DesktopConversationView {...props} sessionId="ss-two" />);
    expect(screen.queryByRole('dialog', { name: /File preview/ })).toBeNull();
  });

  it('passes the verified thread and file to the project reveal action', async () => {
    const reveal = vi.fn().mockReturnValue(true);
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 2, totalLines: 2,
      lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target line', truncated: false }] }) });
    render(<DesktopConversationView mode="structured" sessionId="ss-one" workspacePath="/work/project" onRevealProjectFile={reveal} structuredMessages={[
      { role: 'assistant', messageId: 'answer', content: '[source](/work/project/src/app.js:2)' },
    ]} structuredToolCalls={[]} connectionState="online" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source at line 2' }));
    await screen.findByText('target line');
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }));
    expect(reveal).toHaveBeenCalledWith({ sessionId: 'ss-one', root: '/work/project', file: { path: 'src/app.js', line: 2 } });
    expect(screen.queryByRole('dialog', { name: /File preview/ })).toBeNull();
  });

  it('hides a preview when its conversation surface becomes inactive', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 2, totalLines: 2,
      lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target line', truncated: false }] }) });
    const props = { mode: 'structured', sessionId: 'ss-one', workspacePath: '/work/project', structuredMessages: [
      { role: 'assistant', messageId: 'answer', content: '[source](/work/project/src/app.js:2)' },
    ], structuredToolCalls: [], connectionState: 'online' };
    const view = render(<DesktopConversationView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source at line 2' }));
    expect(await screen.findByText('target line')).toBeVisible();
    view.rerender(<DesktopConversationView {...props} filePreviewVisible={false} />);
    expect(screen.queryByRole('dialog', { name: /File preview/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'source' })).toBeNull();
  });

  it('does not display a pending file response after switching threads', async () => {
    let finish;
    apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const props = { mode: 'structured', sessionId: 'ss-one', workspacePath: '/work/project', structuredMessages: [
      { role: 'assistant', messageId: 'answer', content: '[source](/work/project/src/app.js:2)' },
    ], structuredToolCalls: [], connectionState: 'online' };
    const view = render(<DesktopConversationView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open source at line 2' }));
    view.rerender(<DesktopConversationView {...props} sessionId="ss-two" />);
    await act(async () => finish({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 2, totalLines: 2,
      lines: [{ line: 2, text: 'stale private output', truncated: false }] }) }));
    expect(screen.queryByText('stale private output')).toBeNull();
    expect(screen.queryByRole('dialog', { name: /File preview/ })).toBeNull();
  });
});
