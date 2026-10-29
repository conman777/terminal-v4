import { beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceImageConversation, startWorkspacePrompt } from './workspaceStart';

let controller;
let authority;
vi.mock('./remoteEnvironments', () => ({ getEnvironmentSignal: () => controller.signal }));
vi.mock('./auth', () => ({ captureAuthScope: () => authority, isAuthScopeCurrent: scope => scope === authority }));
vi.mock('./agentLauncher', () => ({ resolveAgentSessionLaunch: vi.fn() }));
vi.mock('./composerDraftStore', () => ({ getComposerDraftStore: vi.fn() }));
import { resolveAgentSessionLaunch } from './agentLauncher';
import { getComposerDraftStore } from './composerDraftStore';

beforeEach(() => {
  controller = new AbortController();
  authority = {};
  resolveAgentSessionLaunch.mockResolvedValue({ kind: 'structured', provider: 'codex', model: 'model' });
  getComposerDraftStore.mockReturnValue({ setText: vi.fn(), getSnapshot: () => ({ revision: 1 }), clearIfUnchanged: vi.fn() });
});

function fixture() {
  return { customAiProviders: [], createStructuredSession: vi.fn().mockImplementation(async options => {
      const session = { id: 'ss-new', runtime: 'v4' };
      await options.prepareSession?.(session);
      return session;
    }),
    rememberProject: vi.fn(), addSessionToDesktop: vi.fn(), sendToSession: vi.fn().mockResolvedValue({ accepted: true }) };
}

it('does not create a session when the environment changes while resolving the agent', async () => {
  let finish;
  resolveAgentSessionLaunch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const deps = fixture();
  const task = startWorkspacePrompt('Fork context', { path: '/project' }, deps);
  controller.abort();
  finish({ kind: 'structured', provider: 'codex' });
  await expect(task).rejects.toThrow('environment or account changed');
  expect(deps.createStructuredSession).not.toHaveBeenCalled();
});

it('does not send a new thread prompt through a different account after creation', async () => {
  let finish;
  const deps = fixture();
  deps.createStructuredSession.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const task = startWorkspacePrompt('Fork context', { path: '/project' }, deps);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  authority = {};
  finish({ id: 'ss-new' });
  await expect(task).rejects.toThrow('environment or account changed');
  expect([deps.rememberProject.mock.calls, deps.addSessionToDesktop.mock.calls, deps.sendToSession.mock.calls]).toEqual([[], [], []]);
});

it('creates a scoped session and clears only the submitted draft after acceptance', async () => {
  const deps = fixture();
  const result = await startWorkspacePrompt(' Fork context ', { path: '/project', agentId: 'codex', selection: { model: 'model' } }, deps);
  expect(result).toEqual({ accepted: true, sessionId: 'ss-new' });
  expect(deps.sendToSession).toHaveBeenCalledWith('ss-new', 'Fork context');
  expect(getComposerDraftStore('ss-new').clearIfUnchanged).toHaveBeenCalledWith(1, 'Fork context');
});

it('keeps the draft and identifies the session when no acceptance receipt is returned', async () => {
  const deps = fixture();
  deps.sendToSession.mockResolvedValue(undefined);
  const failure = await startWorkspacePrompt('Fork context', { path: '/project' }, deps).catch(error => error);
  expect(failure).toMatchObject({ sessionId: 'ss-new' });
  expect(getComposerDraftStore('ss-new').clearIfUnchanged).not.toHaveBeenCalled();
});

it('retains the submitted draft when acceptance is unconfirmed or the account changes during send', async () => {
  let finish;
  const deps = fixture();
  deps.sendToSession.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const task = startWorkspacePrompt('Fork context', { path: '/project' }, deps);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const draft = getComposerDraftStore('ss-new');
  authority = {};
  finish({ accepted: true });
  await expect(task).rejects.toThrow('environment or account changed');
  expect(draft.clearIfUnchanged).not.toHaveBeenCalled();
});

it('identifies the created session when a send is rejected and keeps its draft', async () => {
  const deps = fixture();
  deps.sendToSession.mockResolvedValue({ accepted: false });
  const failure = await startWorkspacePrompt('Fork context', { path: '/project' }, deps).catch(error => error);
  expect(failure).toMatchObject({ sessionId: 'ss-new', message: 'The agent did not accept this task. The prompt is saved in the conversation.' });
  expect(getComposerDraftStore('ss-new').clearIfUnchanged).not.toHaveBeenCalled();
});

it('opens a V4 conversation with the draft without sending a first message', async () => {
  const deps = fixture();
  resolveAgentSessionLaunch.mockResolvedValue({ kind: 'structured', provider: 'openai', model: 'image-model' });
  getComposerDraftStore.mockReturnValue({ setText: vi.fn(), getSnapshot: () => ({ text: 'Check this image' }) });
  const result = await openWorkspaceImageConversation('Check this image', { path: '/project', agentId: 'openai' }, deps);
  expect(result).toEqual({ opened: true, sessionId: 'ss-new' });
  expect(getComposerDraftStore('ss-new').setText).toHaveBeenCalledWith('Check this image');
  expect(deps.addSessionToDesktop).toHaveBeenCalledWith('ss-new', undefined);
  expect(deps.sendToSession).not.toHaveBeenCalled();
});

it('does not navigate or discard the source draft when the destination draft cannot be saved', async () => {
  const deps = fixture();
  getComposerDraftStore.mockReturnValue({ setText: vi.fn(), getSnapshot: () => ({ error: 'Storage unavailable' }) });
  await expect(openWorkspaceImageConversation('Keep me', { path: '/project' }, deps)).rejects.toThrow('Storage unavailable');
  expect(deps.addSessionToDesktop).not.toHaveBeenCalled();
  expect(deps.sendToSession).not.toHaveBeenCalled();
});

it('does not prepare or open an image conversation after the account changes', async () => {
  const deps = fixture();
  let finish;
  deps.createStructuredSession.mockImplementation(options => new Promise((resolve, reject) => { finish = async () => {
    try { await options.prepareSession({ id: 'ss-new', runtime: 'v4' }); resolve({ id: 'ss-new', runtime: 'v4' }); }
    catch (error) { reject(error); }
  }; }));
  const pending = openWorkspaceImageConversation('Keep this draft', { path: '/project' }, deps);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  authority = {};
  finish();
  await expect(pending).rejects.toThrow('environment or account changed');
  expect(deps.addSessionToDesktop).not.toHaveBeenCalled();
});

it('keeps a delayed image conversation on its originating desktop after navigation', async () => {
  const deps = fixture();
  const draft = { setText: vi.fn(), getSnapshot: () => ({ text: 'Draft' }) };
  getComposerDraftStore.mockReturnValue(draft);
  let current = true, finish;
  deps.createStructuredSession.mockImplementation(options => new Promise(resolve => { finish = async () => {
    await options.prepareSession({ id: 'ss-new', runtime: 'v4' });
    expect(options.shouldSelectSession()).toBe(false);
    resolve({ id: 'ss-new', runtime: 'v4' });
  }; }));
  const pending = openWorkspaceImageConversation('Draft', { path: '/project' }, { ...deps, desktopId: 'desktop-1', isDesktopCurrent: () => current });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  current = false;
  finish();
  await expect(pending).resolves.toEqual({ opened: true, sessionId: 'ss-new' });
  expect(deps.addSessionToDesktop).toHaveBeenCalledWith('ss-new', 'desktop-1');
});
