import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FolderBrowserModal } from './FolderBrowserModal';

const apiFetchMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiFetch: (...args) => apiFetchMock(...args)
}));

describe('FolderBrowserModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    localStorage.clear();
  });

  it('renders the modal overlay at the document root when opened', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects',
        folders: ['terminal v4'],
        parent: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents'
      })
    });

    const { container } = render(
      <FolderBrowserModal
        isOpen={true}
        onClose={vi.fn()}
        currentPath="C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects"
        recentFolders={[]}
        onSelect={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open here' })).toBeInTheDocument();
    });

    expect(container).toBeEmptyDOMElement();
    expect(document.body.querySelector('.modal-overlay')).toBeTruthy();
  });

  it('does not reload the same directory when ai options rerender with a new array identity', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
        folders: ['src'],
        parent: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects'
      })
    });

    const props = {
      isOpen: true,
      onClose: vi.fn(),
      currentPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
      recentFolders: [],
      onSelect: vi.fn(),
      showAiSelector: true,
      defaultAiOptionId: 'cli'
    };

    const { rerender } = render(
      <FolderBrowserModal
        {...props}
        aiOptions={[
          { id: 'cli', label: 'CLI' },
          { id: 'claude', label: 'Claude Code', title: 'Claude Code', command: 'claude --dangerously-skip-permissions' }
        ]}
      />
    );

    await waitFor(() => {
      expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'))).toHaveLength(1);
    });

    rerender(
      <FolderBrowserModal
        {...props}
        aiOptions={[
          { id: 'cli', label: 'CLI' },
          { id: 'claude', label: 'Claude Code', title: 'Claude Code', command: 'claude --dangerously-skip-permissions' }
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open here' })).toBeInTheDocument();
    });
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'))).toHaveLength(1);
  });

  it('passes the selected native agent, model, and reasoning into session creation', async () => {
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/agent/catalog')) {
        return {
          ok: true,
          json: async () => ({
            defaultAgent: 'codex',
            agents: [
              { id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', default: true }, { id: 'gpt-5.5', label: 'GPT-5.5' }], reasoningLevels: ['low', 'high'] },
              { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'sonnet', label: 'Sonnet' }], reasoningLevels: ['low', 'high'] },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ path: '/home/conor/terminal-v4', folders: [], parent: '/home/conor' }) };
    });
    const onSelect = vi.fn();

    render(
      <FolderBrowserModal
        isOpen
        onClose={vi.fn()}
        currentPath="/home/conor/terminal-v4"
        recentFolders={[]}
        onSelect={onSelect}
        showAiSelector
        aiOptions={[
          { id: 'cli', label: 'CLI' },
          { id: 'codex', label: 'Codex', title: 'Codex', command: 'codex' },
        ]}
      />
    );

    fireEvent.click(document.querySelector('.pro-fb-select-trigger'));
    fireEvent.click(screen.getByText('Codex'));
    fireEvent.click(await screen.findByRole('button', { name: /Codex model GPT-5\.6-Sol/i }));
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.5/i }));
    fireEvent.change(screen.getByLabelText('Agent reasoning effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }));

    expect(onSelect).toHaveBeenCalledWith(
      '/home/conor/terminal-v4',
      'codex',
      'Codex',
      { model: 'gpt-5.5', reasoning: 'high' },
    );
    expect(JSON.parse(localStorage.getItem('terminalV4AgentModels')).codex).toEqual({
      model: 'gpt-5.5',
      reasoning: 'high',
    });
  });

  it('selects and closes immediately when a recent folder chip is clicked', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        path: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects',
        folders: ['terminal v4'],
        parent: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents'
      })
    });

    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <FolderBrowserModal
        isOpen={true}
        onClose={onClose}
        currentPath="C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects"
        recentFolders={['C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4']}
        onSelect={onSelect}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'terminal v4' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4'));

    expect(onSelect).toHaveBeenCalledWith(
      'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4',
      undefined,
      undefined
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'))).toHaveLength(1);
  });

  it('applies saved project agent, model, and reasoning when opening that folder', async () => {
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/workspace/profile')) return {
        ok: true, json: async () => ({ defaultAgent: 'claude', selection: { model: 'sonnet', reasoning: 'high' } }),
      };
      if (String(url).startsWith('/api/agent/catalog')) return {
        ok: true, json: async () => ({ agents: [
          { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'sonnet', label: 'Sonnet' }], reasoningLevels: ['low', 'high'] },
        ] }),
      };
      return { ok: true, json: async () => ({ path: '/projects/api', folders: [], parent: '/projects' }) };
    });
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen currentPath="/projects/api" recentFolders={[]} onClose={vi.fn()} onSelect={onSelect}
      showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }, { id: 'claude', label: 'Claude Code' }]} />);
    await screen.findByRole('button', { name: /Claude Code model Sonnet/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open here' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
    expect(onSelect).toHaveBeenCalledWith('/projects/api', 'claude', '', { model: 'sonnet', reasoning: 'high' });
  });

  it('uses a recent destination project default rather than the current folder default', async () => {
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/workspace/profile')) return {
        ok: true, json: async () => String(url).includes(encodeURIComponent('/projects/recent'))
          ? { defaultAgent: 'claude', selection: { model: 'sonnet', reasoning: 'high' } }
          : { defaultAgent: '' },
      };
      return { ok: true, json: async () => ({ path: '/projects/api', folders: [], parent: '/projects' }) };
    });
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen currentPath="/projects/api" recentFolders={['/projects/recent']} onClose={vi.fn()} onSelect={onSelect}
      showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }, { id: 'claude', label: 'Claude Code' }]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open here' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'recent' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/recent', 'claude', '', { model: 'sonnet', reasoning: 'high' }));
  });

  it('does not launch a recent project if the picker closes while defaults are loading', async () => {
    let finishRecent;
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/workspace/profile') && String(url).includes(encodeURIComponent('/projects/recent'))) {
        return await new Promise(resolve => { finishRecent = resolve; });
      }
      if (String(url).startsWith('/api/workspace/profile')) return { ok: true, json: async () => ({ defaultAgent: '' }) };
      return { ok: true, json: async () => ({ path: '/projects/api', folders: [], parent: '/projects' }) };
    });
    const onSelect = vi.fn();
    const props = { currentPath: '/projects/api', recentFolders: ['/projects/recent'], onClose: vi.fn(), onSelect,
      showAiSelector: true, aiOptions: [{ id: 'cli', label: 'CLI' }] };
    const { rerender } = render(<FolderBrowserModal {...props} isOpen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open here' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'recent' }));
    await waitFor(() => expect(finishRecent).toBeTypeOf('function'));
    rerender(<FolderBrowserModal {...props} isOpen={false} />);
    finishRecent({ ok: true, json: async () => ({ defaultAgent: 'cli' }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
