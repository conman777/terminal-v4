import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as environments from '../utils/remoteEnvironments';
import { setTokens, setUser } from '../utils/auth';
import { WorkspaceStartView, worktreeNameFromPrompt } from './WorkspaceStartView';
import { addContext, buildThreadContext } from './composer-context/composerContext';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { AutocorrectProvider } from '../contexts/AutocorrectContext';
import { resetPullRequestMentionCache } from '../hooks/useCurrentPullRequest';
const apiFetchMock = vi.fn();
const apiGetMock = vi.fn();
const uploadScreenshotMock = vi.fn();
const uploadAttachmentMock = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetchMock(...args), apiGet: (...args) => apiGetMock(...args), uploadScreenshot: (...args) => uploadScreenshotMock(...args), uploadAttachment: (...args) => uploadAttachmentMock(...args) }));
beforeEach(() => {
  localStorage.clear();
  setUser({ id: 'fixture-user' });
  uploadScreenshotMock.mockReset();
  uploadAttachmentMock.mockReset();
  apiGetMock.mockReset();
  resetPullRequestMentionCache();
  apiGetMock.mockImplementation(async url => url === '/api/system/doctor' ? { ready: true, checks: [] } : { pullRequest: null });
  apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
    ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'test-model', label: 'Test model', default: true }], reasoningLevels: ['low', 'high'] }] } : {} }));
});

vi.mock('../hooks/useAutocorrectInput', () => ({
  useAutocorrectInput: () => ({
    handleKeyDown: () => false,
    handleSelectionChange: () => {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe('WorkspaceStartView', () => {
  it('does not automatically focus the new-task composer on a phone', async () => {
    const width = window.innerWidth;
    const visualWidth = window.visualViewport.width;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    window.visualViewport.width = 320;
    try {
      render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" /></AutocorrectProvider>);
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).not.toHaveFocus());
    } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); window.visualViewport.width = visualWidth; }
  });
  it('offers project files and installed skills before the first message', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, models: [{ id: 'test-model', default: true }] }] }
      : String(url).startsWith('/api/workspace/files?') ? { files: ['src/login.js'] }
        : String(url).startsWith('/api/workspace/skills?') ? { skills: [{ name: 'review', path: '/project/.skills/review/SKILL.md' }] } : {} }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(input, { target: { value: 'Inspect @log' } });
    fireEvent.click(await screen.findByRole('option', { name: /src\/login.js/ }));
    expect(input).toHaveValue('Inspect @src/login.js ');
    fireEvent.change(input, { target: { value: '/review' } });
    fireEvent.click(await screen.findByRole('option', { name: /\/review/ }));
    expect(input).toHaveValue('Use the "review" skill (instructions: /project/.skills/review/SKILL.md). ');
  });

  it('offers owned thread and current pull request references before starting and sends their context', async () => {
    apiGetMock.mockImplementation(async url => url === '/api/system/doctor' ? { ready: true, checks: [] } : { pullRequest: { number: 7, title: 'Login fix', url: 'https://github.com/example/repo/pull/7' } });
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} sessions={[
      { id: 'ss-prior', title: 'Earlier investigation' }, { id: 'ss-hidden', title: 'Archived investigation', thread: { archived: true } },
    ]} /></AutocorrectProvider>);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled());
    fireEvent.change(input, { target: { value: 'Follow @Earlier' } });
    fireEvent.click(await screen.findByRole('option', { name: /Earlier investigation/ }));
    expect(screen.queryByRole('option', { name: /Archived investigation/ })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Follow @Login' } });
    fireEvent.click(await screen.findByRole('option', { name: /#7 Login fix/ }));
    fireEvent.change(input, { target: { value: 'Follow these references' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.stringContaining('Reference to another thread of this user "Earlier investigation" (id ss-prior).'), expect.objectContaining({ path: '/project' })));
    expect(submit.mock.calls[0][0]).toContain('Reference to a pull request "#7 Login fix" (id 7). URL: https://github.com/example/repo/pull/7');
  });

  it('keeps the start draft and blocks submission if a selected thread becomes unavailable', async () => {
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    const thread = { id: 'ss-prior', title: 'Earlier investigation' };
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" sessions={[thread]} onSubmitPrompt={submit} /></AutocorrectProvider>);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(input, { target: { value: 'Follow @Earlier' } });
    fireEvent.click(await screen.findByRole('option', { name: /Earlier investigation/ }));
    view.rerender(<AutocorrectProvider><WorkspaceStartView currentPath="/project" sessions={[]} onSubmitPrompt={submit} /></AutocorrectProvider>);
    expect(screen.getByRole('list', { name: 'Attached context' })).toHaveTextContent('Unavailable');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Remove unavailable');
    expect(input).toHaveValue('Follow ');
    expect(submit).not.toHaveBeenCalled();
  });

  it('names new worktrees from the task text instead of serialized context metadata', () => {
    const prompt = addContext('Investigate the login bug', buildThreadContext({ id: 'ss-prior', title: 'Earlier investigation' }));
    expect(worktreeNameFromPrompt(prompt)).toBe('Investigate the login bug');
  });

  it('does not reuse a late file suggestion after changing projects and keeps the draft', async () => {
    let resolveOld;
    apiFetchMock.mockImplementation(async url => {
      if (String(url).startsWith('/api/workspace/files?')) {
        if (String(url).includes('path=%2Ffirst')) return new Promise(resolve => { resolveOld = resolve; });
        return { ok: true, json: async () => ({ files: ['src/new.js'] }) };
      }
      return { ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
        ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, models: [{ id: 'test-model', default: true }] }] } : {} };
    });
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/first" /></AutocorrectProvider>);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(input, { target: { value: 'Check @src' } });
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    view.rerender(<AutocorrectProvider><WorkspaceStartView currentPath="/second" /></AutocorrectProvider>);
    await act(async () => resolveOld({ ok: true, json: async () => ({ files: ['src/private-old.js'] }) }));
    expect(await screen.findByRole('option', { name: /src\/new.js/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /private-old/ })).not.toBeInTheDocument();
    expect(input).toHaveValue('Check @src');
  });
  it('opens an empty V4 conversation for a first image and carries the existing text', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'v4', available: true, capabilities: { structured: true }, models: [{ id: 'test-model', label: 'Test model', default: true }] }] } : {} }));
    const open = vi.fn().mockResolvedValue({ opened: true, sessionId: 'ss-new' });
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} onOpenImageConversation={open} /></AutocorrectProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Review this picture' } });
    const button = await screen.findByRole('button', { name: 'Open conversation to add images' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledWith('Review this picture', expect.objectContaining({ path: '/project', agentId: 'codex' })));
    expect(submit).not.toHaveBeenCalled();
  });

  it('holds an uncertain empty conversation creation instead of retrying it', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'v4', available: true, capabilities: { structured: true }, models: [{ id: 'test-model', default: true }] }] } : {} }));
    const open = vi.fn().mockRejectedValue(new TypeError('Connection lost'));
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onOpenImageConversation={open} /></AutocorrectProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Keep my draft' } });
    const button = await screen.findByRole('button', { name: 'Open conversation to add images' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/may have been created/i)).toBeInTheDocument();
    view.unmount();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onOpenImageConversation={open} /></AutocorrectProvider>);
    expect(await screen.findByRole('button', { name: 'Open conversation to add images' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my draft');
    expect(open).toHaveBeenCalledTimes(1);
  });
  it.each(['drop', 'paste', 'HTML image paste'])('rejects an unsupported V4 start image through %s without uploading or discarding the prompt', async source => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'v4', available: true, capabilities: { structured: true }, models: [{ id: 'test-model', label: 'Test model', default: true }] }] } : {} }));
    const submit = vi.fn();
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Use the screenshot to fix this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    const transfer = { types: ['Files'], files: [new File(['synthetic'], 'start-image.png', { type: 'image/png' })], items: [], getData: () => '' };
    if (source === 'HTML image paste') {
      transfer.files = [];
      transfer.types = ['text/html'];
      transfer.getData = type => type === 'text/html' ? '<img src="data:image/png;base64,iVBORw0KGgo=">' : '';
    }
    if (source === 'drop') {
      fireEvent.dragOver(composer.closest('form'), { dataTransfer: transfer });
      expect(transfer.dropEffect).toBe('none');
      expect(screen.getByRole('alert')).toHaveTextContent('Images cannot be attached on this screen.');
      fireEvent.drop(composer.closest('form'), { dataTransfer: transfer });
    } else fireEvent.paste(composer, { clipboardData: transfer });
    expect(await screen.findByRole('alert')).toHaveTextContent('Images cannot be attached on this screen. Open a conversation to add images.');
    expect(uploadScreenshotMock).not.toHaveBeenCalled();
    expect(view.container.querySelector('.status-composer-attachment-name')).toBeNull();
    expect(composer).toHaveValue('Use the screenshot to fix this');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(submit).toHaveBeenCalledWith('Use the screenshot to fix this', expect.objectContaining({ path: '/project' }));
  });

  it('saves an uploaded native image and submits its exact path with the task', async () => {
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    expect(await screen.findByText('image.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('Review this\n\nAttached files:\n- ~/screenshots/test.png', expect.objectContaining({ path: '/project' })));
  });

  it('uploads a selected document and sends the returned path', async () => {
    uploadAttachmentMock.mockResolvedValue('/server/uploads/notes.pdf');
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    fireEvent.change(view.container.querySelector('input[type=file]'), { target: { files: [new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })] } });
    await screen.findByText('notes.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('Review this\n\nAttached files:\n- /server/uploads/notes.pdf', expect.objectContaining({ path: '/project' })));
  });

  it('retains the native attachment and prevents automatic retry after an uncertain start, including after remount', async () => {
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    const submit = vi.fn().mockRejectedValue(new TypeError('Connection lost'));
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    await screen.findByText('image.png');
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByText(/may have started/i)).toBeInTheDocument();
    expect(screen.queryByText('Project selected. Describe your task above, then send to start.')).not.toBeInTheDocument();
    view.unmount();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    expect(await screen.findByText('image.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.queryByText('Project selected. Describe your task above, then send to start.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Review this');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps the attachment and holds the request when the callback provides no acceptance receipt', async () => {
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    await screen.findByText('image.png');
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByText(/may have started/i)).toBeInTheDocument();
    expect(composer).toHaveValue('Review this');
    expect(screen.getByText('image.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('retains native attachments but refuses to send them through a V4 provider', async () => {
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => String(url).startsWith('/api/agent/catalog')
      ? { ok: true, json: async () => ({ agents: [
        { id: 'codex', label: 'Codex', runtime: 'codex', available: true, capabilities: { structured: true }, models: [{ id: 'test-model', default: true }] },
        { id: 'v4-fixture', label: 'V4 fixture', runtime: 'v4', available: true, capabilities: { structured: true }, models: [{ id: 'v4-model', default: true }] },
      ] }) } : base(url, options));
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    await screen.findByText('image.png');
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'V4 fixture' }));
    expect(screen.getByText(/Choose Codex or Claude to send/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('image.png')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['account', 'environment'])('does not add an upload that finishes after the %s changes', async scope => {
    let finishUpload;
    uploadScreenshotMock.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'old.png', { type: 'image/png' })], items: [], getData: () => '' } });
    await waitFor(() => expect(finishUpload).toBeDefined());
    act(() => { if (scope === 'account') setUser({ id: 'other-user' }); else environments.setActiveEnvironment({ id: 'other-host' }); });
    await act(async () => { finishUpload('~/screenshots/old.png'); });
    expect(screen.queryByText('old.png')).not.toBeInTheDocument();
    if (scope === 'environment') act(() => environments.setActiveEnvironment(null));
  });

  it.each(['account', 'environment'])('keeps saved attachments scoped to their original %s', async scope => {
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'private.png', { type: 'image/png' })], items: [], getData: () => '' } });
    await screen.findByText('private.png');
    act(() => { if (scope === 'account') setUser({ id: 'other-user' }); else environments.setActiveEnvironment({ id: 'other-host' }); });
    expect(screen.queryByText('private.png')).not.toBeInTheDocument();
    act(() => { if (scope === 'account') setUser({ id: 'fixture-user' }); else environments.setActiveEnvironment(null); });
    expect(await screen.findByText('private.png')).toBeInTheDocument();
  });

  it('keeps the task text and allows retry when an upload fails', async () => {
    uploadScreenshotMock.mockRejectedValue(new Error('Upload failed'));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
    expect(composer).toHaveValue('Keep this task');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
  });

  it('blocks submission when attachment persistence fails and keeps the uploaded path for retry', async () => {
    const setItem = Storage.prototype.setItem;
    let failSave = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (failSave && key.includes('workspaceStartAttachments:v1:')) throw new Error('Storage full');
      return setItem.call(this, key, value);
    });
    uploadScreenshotMock.mockResolvedValue('~/screenshots/test.png');
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Review this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled());
    fireEvent.paste(composer, { clipboardData: { types: ['Files'], files: [new File(['synthetic'], 'image.png', { type: 'image/png' })], items: [], getData: () => '' } });
    expect(await screen.findByText('image.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
    failSave = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving attachments' }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('Review this\n\nAttached files:\n- ~/screenshots/test.png', expect.anything()));
  });

  it('can start a task in its own git worktree, named after the task', async () => {
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => String(url) === '/api/workspace/git/worktrees'
      ? { ok: true, json: async () => ({ id: 'w1', name: 'Fix the login bug', path: '/worktrees/fix-the-login-bug', branch: 'task/fix-the-login-bug' }) }
      : base(url, options));
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Fix the login bug!' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const created = apiFetchMock.mock.calls.find(([url]) => url === '/api/workspace/git/worktrees');
    expect([created[1].body, submit.mock.calls[0][0], submit.mock.calls[0][1].path]).toEqual([
      { path: '/project', name: 'Fix the login bug', baseRef: 'HEAD', operationId: expect.any(String) }, 'Fix the login bug!', '/worktrees/fix-the-login-bug',
    ]);
  });

  describe('worktree lineage', () => {
    beforeEach(() => apiFetchMock.mockClear());
    const startWorktree = async (props, receipt = { accepted: true, sessionId: 'ss-child' }) => {
      const base = apiFetchMock.getMockImplementation();
      apiFetchMock.mockImplementation(async (url, options) => String(url) === '/api/workspace/git/worktrees'
        ? { ok: true, json: async () => ({ path: '/worktrees/task' }) } : base(url, options));
      const submit = vi.fn().mockResolvedValue(receipt);
      render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} {...props} /></AutocorrectProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Where' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Do the task' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
      await waitFor(() => expect(submit).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
    };
    const lineageCalls = () => apiFetchMock.mock.calls.filter(([url]) => url === '/api/thread-lineage');

    it('records a worktree link from the thread the task was started from', async () => {
      await startWorktree({ originThread: { id: 'ss-parent', paths: ['/project'] } });
      await waitFor(() => expect(lineageCalls()).toHaveLength(1));
      expect(lineageCalls()[0][1]).toMatchObject({ method: 'PUT', body: { childId: 'ss-child', parentId: 'ss-parent', kind: 'worktree' } });
    });

    it.each([
      ['there is no parent thread', {}],
      ['the parent belongs to another project', { originThread: { id: 'ss-parent', paths: ['/elsewhere'] } }],
    ])('records nothing when %s', async (_name, props) => {
      await startWorktree(props);
      expect(lineageCalls()).toEqual([]);
    });

    it('records nothing for a task started in place', async () => {
      const submit = vi.fn().mockResolvedValue({ accepted: true, sessionId: 'ss-child' });
      render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} originThread={{ id: 'ss-parent', paths: ['/project'] }} /></AutocorrectProvider>);
      fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Do the task' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
      await waitFor(() => expect(submit).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
      expect(lineageCalls()).toEqual([]);
    });

    it('records nothing when the agent did not accept the task', async () => {
      await startWorktree({ originThread: { id: 'ss-parent', paths: ['/project'] } }, { accepted: false, sessionId: 'ss-child' });
      expect(lineageCalls()).toEqual([]);
    });
  });

  it('uses the selected base ref for a new worktree and resets it when the project changes', async () => {
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => String(url) === '/api/workspace/git/worktrees'
      ? { ok: true, json: async () => ({ path: '/worktrees/task' }) }
      : base(url, options));
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Worktree base branch or commit' }), { target: { value: 'feature/review' } });
    view.rerender(<AutocorrectProvider><WorkspaceStartView currentPath="/other-project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Worktree base branch or commit' })).toHaveValue('HEAD'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Worktree base branch or commit' }), { target: { value: 'release/stable' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Review the release' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const created = apiFetchMock.mock.calls.findLast(([url]) => url === '/api/workspace/git/worktrees');
    expect(created[1].body).toEqual({ path: '/other-project', name: 'Review the release', baseRef: 'release/stable', operationId: expect.any(String) });
  });

  it('discovers workspace branches and uses a selected branch while retaining manual input and the prompt', async () => {
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => String(url).startsWith('/api/workspace/git/branches?')
      ? { ok: true, json: async () => ({ branches: ['refs/heads/main', 'refs/remotes/origin/release'], truncated: false }) }
      : String(url) === '/api/workspace/git/worktrees'
        ? { ok: true, json: async () => ({ path: '/worktrees/task' }) }
        : base(url, options));
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Keep the task' } });
    const choices = await screen.findByRole('combobox', { name: 'Choose a base branch' });
    fireEvent.change(choices, { target: { value: 'refs/remotes/origin/release' } });
    expect(screen.getByRole('textbox', { name: 'Worktree base branch or commit' })).toHaveValue('refs/remotes/origin/release');
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep the task');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls.findLast(([url]) => url === '/api/workspace/git/worktrees')[1].body.baseRef).toBe('refs/remotes/origin/release');
  });

  it('ignores stale branch discovery after the project changes and allows manual entry when unavailable', async () => {
    let resolveOld;
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => String(url).includes('/api/workspace/git/branches?path=%2Fproject')
      ? new Promise(resolve => { resolveOld = resolve; })
      : String(url).startsWith('/api/workspace/git/branches?')
        ? { ok: false, json: async () => ({}) }
        : base(url, options));
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<AutocorrectProvider><WorkspaceStartView currentPath="/other" /></AutocorrectProvider>);
    resolveOld({ ok: true, json: async () => ({ branches: ['secret-old-branch'] }) });
    await screen.findByText(/Branch list unavailable/);
    expect(screen.queryByText('secret-old-branch')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Worktree base branch or commit' }), { target: { value: 'custom/ref' } });
    expect(screen.getByRole('textbox', { name: 'Worktree base branch or commit' })).toHaveValue('custom/ref');
  });

  it.each(['account', 'environment'])('discards stale branches after changing %s', async scope => {
    let resolveOld;
    let requests = 0;
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => {
      if (!String(url).startsWith('/api/workspace/git/branches?')) return base(url, options);
      requests += 1;
      if (requests === 1) return new Promise(resolve => { resolveOld = resolve; });
      return { ok: true, json: async () => ({ branches: ['refs/heads/new-branch'] }) };
    });
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    await waitFor(() => expect(resolveOld).toBeDefined());
    act(() => { if (scope === 'account') setTokens('new-access', 'new-refresh'); else environments.setActiveEnvironment({ id: 'new-host' }); });
    resolveOld({ ok: true, json: async () => ({ branches: ['refs/heads/old-branch'] }) });
    expect(await screen.findByRole('option', { name: 'new-branch' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'old-branch' })).not.toBeInTheDocument();
    view.unmount();
    if (scope === 'environment') act(() => environments.setActiveEnvironment(null));
  });

  it('reuses a persisted worktree operation after an ambiguous response and remount', async () => {
    const base = apiFetchMock.getMockImplementation();
    const bodies = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url !== '/api/workspace/git/worktrees') return base(url, options);
      bodies.push(options.body);
      if (bodies.length === 1) throw new Error('Connection lost');
      return { ok: true, json: async () => ({ path: '/worktrees/task' }) };
    });
    const submit = vi.fn().mockResolvedValue({ accepted: true });
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const choose = () => { fireEvent.click(screen.getByRole('button', { name: 'Where' })); fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ })); };
    choose();
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Keep this task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await screen.findByText('Connection lost');
    view.unmount();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    choose();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(bodies.map(body => body.operationId)).toEqual([expect.any(String), bodies[0].operationId]);
  });

  it('explains that a lost worktree connection might have created a checkout', async () => {
    const base = apiFetchMock.getMockImplementation();
    apiFetchMock.mockImplementation(async (url, options) => url === '/api/workspace/git/worktrees' ? Promise.reject(new TypeError('Failed to fetch')) : base(url, options));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Keep my task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost while creating the worktree.');
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my task');
  });

  it('requires an explicit new request after an ambiguous worktree failure', async () => {
    const base = apiFetchMock.getMockImplementation();
    const requests = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url !== '/api/workspace/git/worktrees') return base(url, options);
      requests.push(options.body);
      throw new Error('Creation unconfirmed');
    });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Keep my task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await screen.findByText('Creation unconfirmed');
    expect(screen.getByText(/previous request may have created a checkout/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Use a new worktree request' }));
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].operationId).not.toBe(requests[0].operationId);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my task');
  });

  it('shows setup progress, cancels for real, and does not call a cleaned cancel an ambiguous request', async () => {
    const base = apiFetchMock.getMockImplementation();
    const requests = [];
    let resolveCreate;
    let cancelled = false;
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/workspace/git/worktrees') {
        requests.push(options.body);
        if (requests.length > 1) return { ok: true, json: async () => ({ path: '/worktrees/task' }) };
        return new Promise(resolve => { resolveCreate = resolve; });
      }
      if (String(url).startsWith('/api/workspace/git/worktrees/progress')) return { ok: true, json: async () => ({ status: cancelled ? 'cancelled' : 'running', cancelling: false, elapsedMs: 1000, cleaned: cancelled ? true : null, cleanup: cancelled ? 'The partial checkout and its branch were removed.' : null, tail: ['npm install'],
        stages: [{ id: 'base', label: 'Checking base', status: 'done' }, { id: 'checkout', label: 'Creating worktree', status: 'done' }, { id: 'setup', label: 'Setup script', status: cancelled ? 'cancelled' : 'running' }] }) };
      if (url === '/api/workspace/git/worktrees/cancel') { cancelled = true; resolveCreate({ ok: false, json: async () => ({ error: 'Worktree creation was cancelled and the partial checkout was removed.' }) }); return { ok: true, json: async () => ({ status: 'running', cancelling: true, stages: [] }) }; }
      return base(url, options);
    });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn().mockResolvedValue({ accepted: true })} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Slow setup task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByLabelText('Worktree setup progress')).toBeVisible();
    expect(await screen.findByLabelText('Latest setup output')).toHaveTextContent('npm install');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel worktree setup' }));
    expect(await screen.findByText('Worktree creation was cancelled and the partial checkout was removed.')).toBeVisible();
    expect(screen.queryByText(/previous request may have created a checkout/i)).toBeNull();
    expect(screen.queryByLabelText('Worktree setup progress')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Slow setup task');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/git/worktrees/cancel', { method: 'POST', body: { operationId: requests[0].operationId } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].operationId).not.toBe(requests[0].operationId);
  });

  it('offers to remove an unfinished checkout after an ambiguous failure and then starts with a new request', async () => {
    const base = apiFetchMock.getMockImplementation();
    const requests = [];
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/workspace/git/worktrees') {
        requests.push(options.body);
        if (requests.length === 1) return { ok: false, json: async () => ({ error: 'Worktree creation is unconfirmed.' }) };
        return { ok: true, json: async () => ({ path: '/worktrees/task' }) };
      }
      if (url === '/api/workspace/git/worktrees/discard') return { ok: true, json: async () => ({ discarded: true }) };
      return base(url, options);
    });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn().mockResolvedValue({ accepted: true })} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Half done' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the unfinished checkout' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove the unfinished checkout' })).toBeNull());
    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/git/worktrees/discard', { method: 'POST', body: { path: '/project', worktreeId: requests[0].operationId } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].operationId).not.toBe(requests[0].operationId);
  });

  it('keeps the prompt when a worktree base is empty', async () => {
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Where' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /New worktree/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Worktree base branch or commit' }), { target: { value: '  ' } });
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task' } });
    await screen.findByText('Enter a base branch or commit for the worktree.');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(composer).toHaveValue('Keep this task');
    expect(submit).not.toHaveBeenCalled();
  });

  it('explains the missing project prerequisite while preserving an editable draft', async () => {
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView onSubmitPrompt={submit} onAddWorkspace={vi.fn()} /></AutocorrectProvider>);
    expect(await screen.findByText('Choose a project before starting a task.')).toBeVisible();
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this prompt until a project is chosen' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(composer).toHaveValue('Keep this prompt until a project is chosen');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Install the synthetic Codex runtime on this host.'])('explains an unavailable agent and rechecks without sending the prompt: %j', async reason => {
    let available = false;
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available, reason, capabilities: { structured: true }, models: [{ id: 'test-model', label: 'Test model', default: true }] }] } : {} }));
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const hint = reason ? `Codex is unavailable. ${reason}` : 'Codex is unavailable. Complete agent setup on this host, then recheck availability.';
    expect(await screen.findByText(hint)).toBeVisible();
    expect(screen.queryByText('Project selected. Describe your task above, then send to start.')).not.toBeInTheDocument();
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep the task while agent setup completes' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    available = true;
    fireEvent.click(screen.getByRole('button', { name: 'Recheck availability' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    expect(composer).toHaveValue('Keep the task while agent setup completes');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText('Project selected. Describe your task above, then send to start.')).toBeVisible();
  });

  it('explains an empty compatible-agent catalog and leaves the draft editable for retry', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ agents: [] }) });
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('No compatible agents are available');
    expect(screen.getByRole('button', { name: 'Retry loading agents' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBeEnabled();
    expect(screen.queryByText('Project selected. Describe your task above, then send to start.')).not.toBeInTheDocument();
  });

  it('retries a failed catalog in place while retaining the project and unsent prompt', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Synthetic catalog unavailable'));
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task through retry' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic catalog unavailable');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading agents' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(composer).toHaveValue('Keep this task through retry');
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(submit).toHaveBeenCalledWith('Keep this task through retry', expect.objectContaining({ path: '/project' }));
  });

  it('preserves context added from navigation while a task launch is being accepted', async () => {
    let accept;
    const submit = vi.fn(() => new Promise(resolve => { accept = resolve; }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Launch this task' } });
    const send = screen.getByRole('button', { name: 'Start task' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(screen.getByText('Starting your task…')).toBeVisible();
    expect(screen.queryByText(/may have started/i)).not.toBeInTheDocument();
    getComposerDraftStore('workspace-start').setText('New context for the next task');
    accept({ accepted: true });
    await waitFor(() => expect(composer).toBeEnabled());
    expect(composer).toHaveValue('New context for the next task');
  });
  it('shares the start prompt with project navigation without sending it', async () => {
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this start draft' } });
    const draft = getComposerDraftStore('workspace-start');
    expect(draft.getSnapshot().text).toBe('Keep this start draft');
    draft.setText(value => `Project context\n\n${value}`);
    await waitFor(() => expect(composer).toHaveValue('Project context\n\nKeep this start draft'));
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([false, { accepted: false }])('retains the prompt when launch returns a negative acceptance receipt %j', async receipt => {
    const submit = vi.fn().mockResolvedValue(receipt);
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task until accepted' } });
    const send = screen.getByRole('button', { name: 'Start task' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent did not accept this task');
    expect(composer).toHaveValue('Keep this task until accepted');
  });

  it.each(['missing receipt', 'connection loss'])('holds an unconfirmed text-only start after %s, including after remount', async failure => {
    const submit = failure === 'missing receipt' ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(new TypeError('Connection lost'));
    const view = render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task until confirmed' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByText(/may have started/i)).toBeInTheDocument();
    expect(composer).toHaveValue('Keep this task until confirmed');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    view.unmount();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    expect(await screen.findByText(/may have started/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep this task until confirmed');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start another task' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('locks project, agent model and launch controls until the task is accepted', async () => {
    let accept;
    const submit = vi.fn(() => new Promise(resolve => { accept = resolve; }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Launch once' } });
    const send = screen.getByRole('button', { name: 'Start task' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(screen.getByRole('button', { name: /Codex model Test model/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Project' })).toBeDisabled();
    expect(composer).toHaveValue('Launch once');
    accept({ accepted: true });
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('retains the selected model and draft when choosing the current project again', async () => {
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/work/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this task' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Project', exact: true }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /project/ }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Codex model Test model/ })).toBeEnabled();
    expect(composer).toHaveValue('Keep this task');
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(submit).toHaveBeenCalledWith('Keep this task', expect.objectContaining({ path: '/work/project', selection: expect.objectContaining({ model: 'test-model' }) }));
  });

  it('explains the next step after a project is selected without starting a task', async () => {
    const submit = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/work/project" onSubmitPrompt={submit} /></AutocorrectProvider>);
    expect(await screen.findByText('Project selected. Describe your task above, then send to start.')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the new workspace composer read-only on observer hosts', () => {
    vi.spyOn(environments, 'getActiveEnvironment').mockReturnValue({ id: 'observer-host', capabilities: { terminalInput: false } });
    const onCreateSession = vi.fn();
    const onSubmitPrompt = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath='C:/remote' onCreateSession={onCreateSession} onSubmitPrompt={onSubmitPrompt} /></AutocorrectProvider>);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument();
    expect(screen.getByText('This environment is read-only. Select an existing thread to view its output.')).toBeInTheDocument();
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it('offers every available conversation agent, including Claude Code, but not terminal-only agents', async () => {
    apiFetchMock.mockImplementation(async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
      ? { agents: [
        { id: 'codex', label: 'Codex', runtime: 'codex', available: true, capabilities: { structured: true }, models: [{ id: 'test-model', label: 'Test model', default: true }] },
        { id: 'claude', label: 'Claude Code', runtime: null, available: true, capabilities: { structured: true }, models: [{ id: 'sonnet', label: 'Sonnet', default: true }] },
        { id: 'gemini', label: 'Gemini', runtime: null, available: true, capabilities: { structured: false }, models: [] },
      ] } : {} }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath="/project" onSubmitPrompt={vi.fn()} /></AutocorrectProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Agent', exact: true }));
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([expect.stringContaining('Codex'), expect.stringContaining('Claude Code')]);
  });

  it('starts an agent task with the selected project and model from the main composer', async () => {
    const onCreateSession = vi.fn();
    const onSubmitPrompt = vi.fn();
    const onAddWorkspace = vi.fn();

    render(
      <AutocorrectProvider>
        <WorkspaceStartView
          currentPath="C:/work/terminal-v4"
          onCreateSession={onCreateSession}
          onSubmitPrompt={onSubmitPrompt}
          onAddWorkspace={onAddWorkspace}
        />
      </AutocorrectProvider>
    );

    expect(screen.getByTitle('C:/work/terminal-v4')).toHaveTextContent('terminal-v4');
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeInTheDocument();
    expect(screen.queryByText('Your agents. Your machines. One workspace.')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask Codex to do anything…')).toBeInTheDocument();
    expect(screen.queryByLabelText('More workspace actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace knowledge' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change workspace' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), {
      target: { value: 'Open the API project and inspect auth' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Agent', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));

    expect(onCreateSession).not.toHaveBeenCalled();
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(onSubmitPrompt).toHaveBeenCalledWith('Open the API project and inspect auth', expect.objectContaining({ path: 'C:/work/terminal-v4', agentId: 'codex', selection: expect.objectContaining({ model: 'test-model' }) }));
  });

  it('gives an empty workspace one clear setup action without disabled project controls', () => {
    const onAddWorkspace = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView onAddWorkspace={onAddWorkspace} onCreateSession={vi.fn()} /></AutocorrectProvider>);
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace knowledge' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('retains the task after a launch failure and does not submit twice while starting', async () => {
    let rejectLaunch;
    const onSubmitPrompt = vi.fn(() => new Promise((_, reject) => { rejectLaunch = reject; }));
    render(<AutocorrectProvider><WorkspaceStartView currentPath='/project' onSubmitPrompt={onSubmitPrompt} /></AutocorrectProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Fix the build' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
    rejectLaunch(new Error('Codex is unavailable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex is unavailable');
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Fix the build');
  });

  it('switches an existing project inline without opening the folder launcher', async () => {
    const onAddWorkspace = vi.fn();
    const onSubmitPrompt = vi.fn();
    render(<AutocorrectProvider><WorkspaceStartView currentPath='/first' projects={[{ path: '/second', name: 'Second' }]} onAddWorkspace={onAddWorkspace} onSubmitPrompt={onSubmitPrompt} /></AutocorrectProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Second/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), { target: { value: 'Fix the build' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(onSubmitPrompt).toHaveBeenCalledWith('Fix the build', expect.objectContaining({ path: '/second', agentId: 'codex' }));
    expect(onAddWorkspace).not.toHaveBeenCalled();
  });
});
