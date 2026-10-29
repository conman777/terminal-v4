import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('keeps agent options open after a Safari blur with no next focus target', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [] } : { path: '/workspace', folders: [], parent: '/' } }));
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={vi.fn()} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }, { id: 'codex', label: 'Codex' }]} />);
    const trigger = screen.getByRole('button', { name: 'Agent' });
    fireEvent.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: null });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Codex', exact: true }));
    expect(trigger).toHaveTextContent('Codex');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('clears the parent-folder filter when entering a child directory', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).includes(encodeURIComponent('/home/Developer'))
      ? { path: '/home/Developer', folders: ['terminal-v4', 'another-project'], parent: '/home' }
      : { path: '/home', folders: ['Developer', 'Documents'], parent: '/' } }));
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/home" recentFolders={[]} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Developer', exact: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: 'dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Developer', exact: true }));
    expect(await screen.findByRole('button', { name: 'terminal-v4', exact: true })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: 'term' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go up' }));
    expect(await screen.findByRole('button', { name: 'Documents', exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Developer', exact: true })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveValue('');
  });

  it('distinguishes unmatched search results from an empty directory and lets users clear the filter', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/home', folders: ['Developer'], parent: '/' }) });
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/home" recentFolders={[]} onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Developer', exact: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: 'missing' } });
    expect(screen.getByText('No folders match “missing”.')).toBeVisible();
    expect(screen.queryByText('No subfolders')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear folder search' }));
    expect(screen.getByRole('button', { name: 'Developer', exact: true })).toBeVisible();
  });

  it('presents the folder before launch settings and reveals optional naming on demand', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/workspace', folders: ['src'], parent: '/' }) });
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={vi.fn()} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }]} />);
    const dialog = await screen.findByRole('dialog', { name: 'New thread' });
    expect(dialog).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search folders' }).compareDocumentPosition(screen.getByLabelText('Agent')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Tab name')).not.toBeVisible();
    fireEvent.click(screen.getByText('More options'));
    expect(screen.getByLabelText('Tab name')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start thread' })).toBeEnabled());
  });

  it('focuses folder search and closes the launcher with Escape', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/workspace', folders: [], parent: '/' }) });
    const onClose = vi.fn();
    render(<FolderBrowserModal isOpen onClose={onClose} currentPath="/workspace" recentFolders={[]} onSelect={vi.fn()} />);
    const search = screen.getByRole('textbox', { name: 'Search folders' });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('loads a saved connection and requires an explicit model before creating its conversation', async () => {
    const id = 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001';
    const label = 'LM Studio local · 00000001';
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id, label, runtime: 'v4', available: true, status: 'ready', models: [], reasoningLevels: [], capabilities: { structured: true }, connectionProfile: { profileId: '10000000-0000-4000-8000-000000000001', revision: '60000000-0000-4000-8000-000000000001', transport: 'openai-chat' } }] }
      : String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: [], parent: '/' } : { memory: '', skills: [] } }));
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={onSelect} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }]} />);
    fireEvent.click(document.querySelector('.pro-fb-select-trigger'));
    fireEvent.click(await screen.findByText(label, { selector: '.pro-fb-option' }));
    const picker = await screen.findByRole('button', { name: /LM Studio local.*model Choose a model ID/ });
    expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeDisabled();
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('button', { name: 'Enter custom model ID' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom model ID' }), { target: { value: 'own-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use custom model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/workspace', id, label, { model: 'own-model', reasoning: '', available: true }));
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'))).toHaveLength(1);
  });

  it('shows a saved-connection catalog error and lets the user retry', async () => {
    let attempts = 0;
    apiFetchMock.mockImplementation(async url => String(url).startsWith('/api/agent/catalog')
      ? (++attempts === 1 ? { ok: false, json: async () => ({ error: 'Synthetic catalog unavailable' }) } : { ok: true, json: async () => ({ agents: [] }) })
      : { ok: true, json: async () => ({ path: '/workspace', folders: [], parent: '/' }) });
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={vi.fn()} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }]} />);
    expect(await screen.findByText(/Could not load saved connections/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved connections' }));
    await waitFor(() => expect(screen.queryByText(/Could not load saved connections/)).not.toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  it('preserves the selected agent, model, tab name and folder search when saved connections arrive late', async () => {
    let finishCatalog;
    let catalogRequests = 0;
    const catalog = { agents: [{ id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'own-model', label: 'Own model' }], reasoningLevels: [] },
      { id: 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001', label: 'Saved local', runtime: 'v4', available: true, capabilities: { structured: true },
        connectionProfile: { profileId: '10000000-0000-4000-8000-000000000001', revision: '60000000-0000-4000-8000-000000000001', transport: 'openai-chat' } }] };
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/agent/catalog')) {
        if (++catalogRequests === 1) return new Promise(resolve => { finishCatalog = resolve; });
        return { ok: true, json: async () => catalog };
      }
      return { ok: true, json: async () => String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: ['src', 'docs'], parent: '/' } : {} };
    });
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={onSelect} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }, { id: 'codex', label: 'Codex' }]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeEnabled());
    fireEvent.click(document.querySelector('.pro-fb-select-trigger'));
    fireEvent.click(screen.getByText('Codex', { selector: '.pro-fb-option' }));
    await screen.findByRole('button', { name: 'Codex model Own model' });
    fireEvent.change(screen.getByLabelText('Tab name'), { target: { value: 'My conversation' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: 'src' } });
    await act(async () => finishCatalog({ ok: true, json: async () => catalog }));
    expect(document.querySelector('.pro-fb-select-trigger')).toHaveTextContent('Codex');
    expect(screen.getByRole('button', { name: 'Codex model Own model' })).toBeInTheDocument();
    expect(screen.getByLabelText('Tab name')).toHaveValue('My conversation');
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveValue('src');
    expect(screen.queryByRole('button', { name: 'docs' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));
    expect(onSelect).toHaveBeenCalledWith('/workspace', 'codex', 'My conversation', { model: 'own-model', reasoning: '' });
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'))).toHaveLength(1);
  });

  it('preserves a model edited under the implicit project default when saved connections arrive late', async () => {
    let finishCatalog;
    let catalogRequests = 0;
    const catalog = { agents: [{ id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }], reasoningLevels: [] },
      { id: 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001', label: 'Saved local', runtime: 'v4', available: true, capabilities: { structured: true },
        connectionProfile: { profileId: '10000000-0000-4000-8000-000000000001', revision: '60000000-0000-4000-8000-000000000001', transport: 'openai-chat' } }] };
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/agent/catalog')) {
        if (++catalogRequests === 1) return new Promise(resolve => { finishCatalog = resolve; });
        return { ok: true, json: async () => catalog };
      }
      return { ok: true, json: async () => String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: [], parent: '/' }
        : { defaultAgent: 'codex', selection: { model: 'model-a', reasoning: '' } } };
    });
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={onSelect} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }, { id: 'codex', label: 'Codex' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Codex model Model A' }));
    fireEvent.click(screen.getByRole('option', { name: 'Model B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
    expect(screen.getByRole('button', { name: 'Codex model Model B' })).toBeInTheDocument();
    const defaultLoads = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/workspace/profile')).length;
    await act(async () => finishCatalog({ ok: true, json: async () => catalog }));
    await screen.findByText('Saved local', { selector: '.pro-fb-option' });
    await waitFor(() => expect(screen.queryByText('Loading project defaults…')).not.toBeInTheDocument());
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/workspace/profile'))).toHaveLength(defaultLoads);
    expect(screen.getByRole('button', { name: 'Codex model Model B' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));
    expect(onSelect).toHaveBeenCalledWith('/workspace', 'codex', '', { model: 'model-b', reasoning: '' });
  });

  it('discards the previous open saved-connection response after closing and reopening', async () => {
    let finishOldCatalog;
    let attempts = 0;
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/agent/catalog')) {
        if (++attempts === 1) return new Promise(resolve => { finishOldCatalog = resolve; });
        return { ok: true, json: async () => ({ agents: [] }) };
      }
      return { ok: true, json: async () => String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: [], parent: '/' } : {} };
    });
    const props = { onClose: vi.fn(), currentPath: '/workspace', recentFolders: [], onSelect: vi.fn(), showAiSelector: true, aiOptions: [{ id: 'cli', label: 'CLI' }] };
    const { rerender } = render(<FolderBrowserModal {...props} isOpen />);
    await waitFor(() => expect(attempts).toBe(1));
    rerender(<FolderBrowserModal {...props} isOpen={false} />);
    rerender(<FolderBrowserModal {...props} isOpen />);
    await waitFor(() => expect(attempts).toBe(2));
    await act(async () => finishOldCatalog({ ok: false, json: async () => ({ error: 'Stale failure' }) }));
    expect(screen.queryByText(/Could not load saved connections/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading saved connections…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeEnabled();
  });

  it('keeps a saved project connection selected and blocks fallback launch while its catalog is pending', async () => {
    const id = 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001';
    let finishCatalog;
    let attempts = 0;
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/agent/catalog')) {
        if (++attempts === 1) return new Promise(resolve => { finishCatalog = resolve; });
        return { ok: true, json: async () => ({ agents: [] }) };
      }
      return { ok: true, json: async () => String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: [], parent: '/' }
        : { defaultAgent: id, selection: { model: 'own-model', reasoning: '' } } };
    });
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={[]} onSelect={onSelect} showAiSelector aiOptions={[{ id: 'codex', label: 'Codex' }]} defaultAiOptionId="codex" />);
    await waitFor(() => expect(screen.queryByText('Loading project defaults…')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => finishCatalog({ ok: true, json: async () => ({ agents: [] }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeDisabled());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not replace a recent saved project connection with a base agent when the catalog omits its revision', async () => {
    const id = 'v4-profile:chat:10000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001';
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog') ? { agents: [] }
      : String(url).startsWith('/api/fs/list') ? { path: '/workspace', folders: [], parent: '/' }
        : String(url).includes(encodeURIComponent('/projects/recent')) ? { defaultAgent: id, selection: { model: 'own-model', reasoning: '' } } : {} }));
    const onSelect = vi.fn();
    render(<FolderBrowserModal isOpen onClose={vi.fn()} currentPath="/workspace" recentFolders={['/projects/recent']} onSelect={onSelect} showAiSelector aiOptions={[{ id: 'cli', label: 'CLI' }]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'recent' }));
    expect(await screen.findByText('Choose an available saved connection and an explicit model ID.')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
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
      expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('option', { name: /GPT-5\.5/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Reasoning:/ }));
    fireEvent.click(screen.getByRole('option', { name: 'High', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));

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
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^(Open here|Start thread)$/ }));
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
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).not.toBeDisabled());
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
    await waitFor(() => expect(screen.getByRole('button', { name: /^(Open here|Start thread)$/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'recent' }));
    await waitFor(() => expect(finishRecent).toBeTypeOf('function'));
    rerender(<FolderBrowserModal {...props} isOpen={false} />);
    finishRecent({ ok: true, json: async () => ({ defaultAgent: 'cli' }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onSelect).not.toHaveBeenCalled();
  });
});


describe('FolderBrowserModal launch ownership', () => {
  beforeEach(() => { apiFetchMock.mockReset(); localStorage.clear(); });
  it.each([true, false])('blocks cross-action launches and releases failures (agent selector %s)', async showAiSelector => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog') ? { agents: [] } : String(url).startsWith('/api/workspace/profile') ? {} : { path: '/workspace', folders: [], parent: '/' } }));
    let rejectLaunch;
    const onSelect = vi.fn(() => new Promise((resolve, reject) => { rejectLaunch = reject; }));
    const onClose = vi.fn();
    render(<FolderBrowserModal isOpen currentPath="/workspace" recentFolders={['/recent']} showAiSelector={showAiSelector} aiOptions={[{id: 'cli', label: 'CLI'}]} onSelect={onSelect} onClose={onClose} />);
    const primary = screen.getByRole('button', { name: /^(Start thread|Open here)$/ });
    await waitFor(() => expect(primary).toBeEnabled());
    fireEvent.click(primary);
    const recent = screen.getByRole('button', { name: 'recent', exact: true });
    expect(recent).toBeDisabled();
    fireEvent.click(recent);
    expect(onSelect.mock.calls).toEqual([['/workspace', showAiSelector ? 'cli' : undefined, showAiSelector ? '' : undefined]]);
    await act(async () => rejectLaunch(new Error('Synthetic create failed')));
    expect(onClose).not.toHaveBeenCalled();
    expect(primary).toBeEnabled();
    fireEvent.click(recent);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(primary).toBeDisabled();
    fireEvent.click(primary);
    expect(onSelect).toHaveBeenCalledTimes(2);
    await act(async () => rejectLaunch(new Error('Synthetic recent failed')));
    expect(recent).toBeEnabled();
  });
});

describe('FolderBrowserModal launch lifecycle', () => {
  it('keeps a pending create owned across close/reopen and ignores its stale close', async () => {
    apiFetchMock.mockImplementation(async url => ({ok: true, json: async () => String(url).startsWith('/api/workspace/profile') ? {} : String(url).startsWith('/api/agent/catalog') ? {agents: []} : {path: '/workspace', folders: [], parent: '/'}}));
    let finish;
    const onSelect = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const onClose = vi.fn();
    const props = {currentPath: '/workspace', recentFolders: ['/recent'], onSelect, onClose};
    const {rerender} = render(<FolderBrowserModal {...props} isOpen />);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Open here'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name: 'Open here'}));
    rerender(<FolderBrowserModal {...props} isOpen={false} />);
    rerender(<FolderBrowserModal {...props} isOpen />);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Starting…'})).toBeDisabled());
    fireEvent.click(screen.getByRole('button', {name: 'recent'}));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name: 'Open here'})).toBeEnabled();
  });

  it('takes launch ownership synchronously before two clicks in one event batch', async () => {
    apiFetchMock.mockResolvedValue({ok: true, json: async () => ({path: '/workspace', folders: [], parent: '/'})});
    const onSelect = vi.fn(() => new Promise(() => {}));
    render(<FolderBrowserModal isOpen currentPath="/workspace" recentFolders={['/recent']} onSelect={onSelect} onClose={vi.fn()} />);
    const primary = screen.getByRole('button', {name: 'Open here'});
    await waitFor(() => expect(primary).toBeEnabled());
    act(() => {
      primary.click();
      screen.getByRole('button', {name: 'recent'}).click();
      primary.click();
    });
    expect(onSelect.mock.calls).toEqual([['/workspace', undefined, undefined]]);
  });
});
