import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('./FolderBrowserModal', () => ({ FolderBrowserModal: () => null }));
vi.mock('./McpSettingsPanel', () => ({ McpSettingsPanel: () => null }));
vi.mock('./AccountKnowledgePanel', () => ({ AccountKnowledgePanel: () => null }));
vi.mock('./AgentBrowserSettingsPanel', () => ({ AgentBrowserSettingsPanel: () => null }));
vi.mock('./ProviderConnectionsPanel', () => ({ ProviderConnectionsPanel: () => null }));
vi.mock('../utils/auth', () => ({
  getAccessToken: () => 'synthetic-settings-token', captureAuthScope: () => ({}), isAuthScopeCurrent: () => true,
}));

function props(overrides = {}) {
  return { isOpen: true, sessionId: 'pty-fixture', currentCwd: '/fixture/original', recentFolders: [],
    onClose: vi.fn(), onSave: vi.fn(), onAddRecentFolder: vi.fn(), terminalFontSize: 14, ...overrides };
}

afterEach(() => { cleanup(); setActiveEnvironment(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('SettingsModal navigation recovery', () => {
  it('keeps the directory until navigation succeeds and permits retry after failure', async () => {
    let rejectNavigation;
    const options = props({ onSave: vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectNavigation = reject; })).mockResolvedValueOnce() });
    render(<SettingsModal {...options} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/fixture/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' }));
    expect(options.onClose).not.toHaveBeenCalled();
    expect(options.onAddRecentFolder).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Navigating/ })).toBeDisabled();
    await act(async () => rejectNavigation(new Error('Failed to navigate session (403)')));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to navigate session (403)');
    expect(screen.getByLabelText('Working Directory')).toHaveValue('/fixture/new');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' })));
    expect(options.onSave.mock.calls).toEqual([['pty-fixture', '/fixture/new'], ['pty-fixture', '/fixture/new']]);
    expect(options.onAddRecentFolder.mock.calls).toEqual([['/fixture/new']]);
    expect(options.onClose).toHaveBeenCalledOnce();
  });

  it('explains that structured conversation workspaces are fixed and preserves the chosen path', async () => {
    const options = props({ sessionId: 'ss-fixture' });
    render(<SettingsModal {...options} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/fixture/new' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' })));
    expect(screen.getByRole('alert')).toHaveTextContent(/fixed workspace.*new conversation/i);
    expect(screen.getByLabelText('Working Directory')).toHaveValue('/fixture/new');
    expect(options.onSave).not.toHaveBeenCalled();
    expect(options.onClose).not.toHaveBeenCalled();
    expect(options.onAddRecentFolder).not.toHaveBeenCalled();
  });
});

describe('SettingsModal folder export', () => {
  it('uses the authenticated active-environment API and reports HTTP failure before allowing retry', async () => {
    setActiveEnvironment({ id: 'synthetic-remote', permissions: { transfer: true } });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['synthetic zip']) });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:synthetic-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const options = props();
    render(<SettingsModal {...options} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/remote/project name' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Download/ })));
    expect(screen.getByRole('alert')).toHaveTextContent(/download.*404/i);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Working Directory')).toHaveValue('/remote/project name');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Download/ })));
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.headers.Authorization])).toEqual(Array(2).fill([
      '/api/environments/synthetic-remote/proxy/api/fs/download?path=%2Fremote%2Fproject+name', 'Bearer synthetic-settings-token',
    ]));
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-export');
    expect(options.onClose).not.toHaveBeenCalled();
  });
});

it('does not close another session settings dialog when an earlier navigation finishes', async () => {
  let finishNavigation;
  const options = props({ onSave: vi.fn(() => new Promise(resolve => { finishNavigation = resolve; })) });
  const { rerender } = render(<SettingsModal {...options} />);
  fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/fixture/next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' }));
  rerender(<SettingsModal {...options} sessionId="pty-other" currentCwd="/fixture/other" />);
  fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/fixture/other-draft' } });
  await act(async () => finishNavigation());
  expect(options.onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Working Directory')).toHaveValue('/fixture/other-draft');
});

it('requires an active terminal session before navigating from global settings', async () => {
  const options = props({ sessionId: null });
  render(<SettingsModal {...options} />);
  fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: '/fixture/new' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save & Navigate' })));
  expect(screen.getByRole('alert')).toHaveTextContent(/select.*terminal session/i);
  expect(options.onSave).not.toHaveBeenCalled();
  expect(options.onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Working Directory')).toHaveValue('/fixture/new');
});
