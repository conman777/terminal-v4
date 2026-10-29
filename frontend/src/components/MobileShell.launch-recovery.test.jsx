import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileShell } from './MobileShell';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { beginAuthChange } from '../utils/auth';

const m = vi.hoisted(() => ({ launch: vi.fn(), send: vi.fn(), props: null, branches: vi.fn(async () => ({ branches: [] })) }));
vi.mock('../utils/agentLauncher', () => ({ resolveAgentLaunchCommand: m.launch }));
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ listSessionGitBranches: m.branches }) }));
vi.mock('../hooks/useMobileChatTurns', () => ({ useMobileChatTurns: () => ({ turns: [], handleChatSend: m.send }) }));
vi.mock('../hooks/useStructuredSession', () => ({ useStructuredSession: () => ({ messages: [], currentToolCalls: [] }) }));
vi.mock('../hooks/useUserImageComposer', () => ({ useUserImageComposer: () => ({}) }));
vi.mock('./LazyTerminalChat', () => ({ LazyTerminalChat: () => null }));
vi.mock('./LazyDesktopConversationView', () => ({ LazyDesktopConversationView: () => null }));
vi.mock('./DesktopStatusBar', () => ({ DesktopStatusBar: props => { m.props = props; return null; } }));
vi.mock('./MobileKeybar', () => ({ MobileKeybar: () => null }));
vi.mock('./WorkspaceToolsButton', () => ({ WorkspaceToolsButton: () => null }));
vi.mock('./WorkspaceProfileButton', () => ({ WorkspaceProfileButton: () => null }));
const sessions = [{ id: 'owned-A', cwd: '/owned' }, { id: 'owned-B', cwd: '/owned' }];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { vi.clearAllMocks(); setActiveEnvironment(null); m.send.mockReturnValue({ queued: false, completion: Promise.resolve() }); });

describe('MobileShell catalog launch ownership', () => {
  it.each(['session', 'ABA', 'environment', 'auth', 'unmount'])('retires late catalog success before delivery after %s changes', async kind => {
    const catalog = deferred(); m.launch.mockReturnValue(catalog.promise);
    const view = render(<MobileShell sessions={sessions} activeSessionId="owned-A" />);
    act(() => m.props.onSelectAiType('codex'));
    if (kind === 'session' || kind === 'ABA') view.rerender(<MobileShell sessions={sessions} activeSessionId="owned-B" />);
    if (kind === 'ABA') view.rerender(<MobileShell sessions={sessions} activeSessionId="owned-A" />);
    if (kind === 'environment') act(() => setActiveEnvironment({ id: 'owned-other' }));
    if (kind === 'auth') act(() => beginAuthChange());
    if (kind === 'unmount') view.unmount();
    await act(async () => catalog.resolve('printf owned_agent'));
    expect(m.send).not.toHaveBeenCalled();
  });

  it('awaits same-scope delivery completion and reports its failure', async () => {
    const completion = deferred(); m.launch.mockResolvedValue('printf owned_agent'); m.send.mockReturnValue({ queued: false, completion: completion.promise });
    const view = render(<MobileShell sessions={sessions} activeSessionId="owned-A" />);
    await act(async () => m.props.onSelectAiType('codex'));
    expect(m.send.mock.calls).toEqual([['printf owned_agent']]);
    await act(async () => completion.reject(new Error('Synthetic delivery rejected; draft kept')));
    expect(view.container.textContent).toContain('Synthetic delivery rejected; draft kept');
  });
});
