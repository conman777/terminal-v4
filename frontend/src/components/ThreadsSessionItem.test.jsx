import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadsSessionItem from './ThreadsSessionItem';

function buildSession(overrides = {}) {
  return {
    id: 'session-1',
    title: 'Old title',
    createdAt: '2026-03-05T18:00:00.000Z',
    thread: {
      topic: 'Old title',
      ...overrides.thread,
    },
    ...overrides,
  };
}

describe('ThreadsSessionItem', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('settles and restores only supported V4 threads without closing them', async () => {
    const user = userEvent.setup();
    const onUpdateThreadMetadata = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    const lifecycle = { supported: true, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false };
    const session = buildSession({ id: 'ss-work', runtime: 'v4', status: 'idle', threadLifecycle: lifecycle });
    const view = render(<ThreadsSessionItem session={session} onSelect={vi.fn()} onClose={onClose} onUpdateThreadMetadata={onUpdateThreadMetadata} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    await user.click(screen.getByRole('menuitem', { name: 'Settle thread' }));
    expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-work', { settled: true });
    view.rerender(<ThreadsSessionItem session={{ ...session, threadLifecycle: { ...lifecycle, settled: true } }} onSelect={vi.fn()} onClose={onClose} onUpdateThreadMetadata={onUpdateThreadMetadata} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    await user.click(screen.getByRole('menuitem', { name: 'Un-settle thread' }));
    expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-work', { settled: false });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers snooze and wake only for supported structured threads', async () => {
    const user = userEvent.setup();
    const onUpdateThreadMetadata = vi.fn().mockResolvedValue({ snooze: { untilMs: 999999, afterSeq: 0 } });
    const session = buildSession({ id: 'ss-work', threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } });
    const view = render(<ThreadsSessionItem session={session} onSelect={vi.fn()} onUpdateThreadMetadata={onUpdateThreadMetadata} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    await user.click(screen.getByRole('menuitem', { name: 'Snooze for one hour' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-work', { snoozeForSeconds: 3600 }));
    view.rerender(<ThreadsSessionItem session={{ ...session, threadLifecycle: { supported: true, snoozed: true } }} onSelect={vi.fn()} onUpdateThreadMetadata={onUpdateThreadMetadata} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    await user.click(screen.getByRole('menuitem', { name: 'Wake thread' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-work', { wakeSnooze: true }));
    view.rerender(<ThreadsSessionItem session={{ ...session, threadLifecycle: undefined }} onSelect={vi.fn()} onUpdateThreadMetadata={onUpdateThreadMetadata} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    expect(screen.queryByRole('menuitem', { name: /Snooze|Wake/ })).not.toBeInTheDocument();
  });
  it('prioritizes a pending request over the working indicator', () => {
    render(<ThreadsSessionItem session={buildSession({ id: 'ss-work', threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } })} isBusy onSelect={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Needs attention' })).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Working' })).not.toBeInTheDocument();
  });

  it('shows a T3-style card with project badge, project, title, branch and status', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-05T18:38:00.000Z').getTime());
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession({ thread: { topic: 'Review the desktop UI' } })}
        projectName="terminal-v4"
        branch="fix/macos-app-verification"
        isBusy={true}
        isActive={false}
        onSelect={vi.fn()}
      />
    );
    const card = container.querySelector('.threads-session-item');
    expect({
      badge: card.querySelector('.threads-project-badge').textContent,
      project: card.querySelector('.threads-card-project').textContent,
      time: card.querySelector('time').textContent,
      title: screen.getByRole('button', { name: 'Select Review the desktop UI' }).textContent,
      branch: card.querySelector('.threads-card-branch').textContent,
      status: screen.getByRole('img', { name: 'Working' }) !== null,
    }).toEqual({ badge: 'TV', project: 'terminal-v4', time: '38m', title: 'Review the desktop UI', branch: 'fix/macos-app-verification', status: true });
  });

  it('keeps pin and activity visible on compact inactive rows with working actions', async () => {
    const user = userEvent.setup();
    const onUnpin = vi.fn();
    const onArchive = vi.fn();
    const { container } = render(<ThreadsSessionItem session={buildSession({thread: {topic: 'Pinned work', pinned: true}})} projectName="Repo" branch="main" isActive={false} hasActivity onUnpin={onUnpin} onArchive={onArchive} onSelect={vi.fn()} />);
    expect(container.querySelector('.threads-session-item')).toHaveClass('compact');
    expect(screen.getByRole('img', {name: 'Pinned'})).toBeInTheDocument();
    expect(screen.getByRole('img', {name: 'Ready to review'})).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Thread actions for Pinned work'}));
    await user.click(screen.getByRole('menuitem', {name: 'Unpin'}));
    await user.click(screen.getByRole('button', {name: 'Thread actions for Pinned work'}));
    await user.click(screen.getByRole('menuitem', {name: 'Archive'}));
    expect([onUnpin.mock.calls, onArchive.mock.calls]).toEqual([[['session-1']], [['session-1']]]);
  });

  it('renames the terminal label from the explicit rename action', () => {
    const onRenameSession = vi.fn();

    render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={true}
        hasActivity={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={onRenameSession}
        onClose={vi.fn()}
      />
    );

    fireEvent.mouseEnter(screen.getByText('Old title').closest('.threads-session-item'));
    fireEvent.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('Old title');
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSession.mock.calls).toEqual([['session-1', 'New title']]);
  });

  it('shows a ready dot for inactive threads with completed activity', () => {
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={false}
        hasActivity={true}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.threads-session-indicator.ready')).toBeTruthy();
    expect(screen.getByLabelText('Ready to review')).toBeInTheDocument();
  });

  it('does not show the ready dot for the active thread', () => {
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession()}
        isBusy={false}
        isActive={true}
        hasActivity={true}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.threads-session-indicator.ready')).toBeNull();
  });

  it('keeps sandbox launch controls out of the thread row actions', () => {
    render(
      <ThreadsSessionItem
        session={buildSession({
          sandbox: { mode: 'off' },
          thread: { sandboxMode: 'off', projectPath: 'C:\\repo' }
        })}
        isBusy={false}
        isActive={true}
        hasActivity={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onUpdateThreadMetadata={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.mouseEnter(screen.getByText('Old title').closest('.threads-session-item'));

    expect(screen.queryByRole('button', { name: /sandbox/i })).not.toBeInTheDocument();
  });

  it('does not show stale sandbox badges from legacy session metadata', () => {
    const { container } = render(
      <ThreadsSessionItem
        session={buildSession({
          sandbox: { mode: 'workspace-write', workspaceRoot: 'C:\\repo' },
          thread: { sandboxMode: 'workspace-write', projectPath: 'C:\\repo' }
        })}
        isBusy={false}
        isActive={true}
        hasActivity={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onUpdateThreadMetadata={vi.fn()}
        onTopicChange={vi.fn()}
        onRenameSession={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector('.threads-session-sandbox-badge')).toBeNull();
  });
});


describe('ThreadsSessionItem keyboard navigation', () => {
  it('selects with Enter and Space and opens independent actions from the keyboard', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onPin = vi.fn();
    render(<ThreadsSessionItem session={buildSession()} onSelect={onSelect} onPin={onPin} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Select Old title' })).toHaveFocus();
    await user.keyboard('{Enter} ');
    expect(onSelect.mock.calls).toEqual([['session-1'], ['session-1']]);
    await user.tab();
    const actions = screen.getByRole('button', { name: 'Thread actions for Old title' });
    expect(actions).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Rename session' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPin.mock.calls).toEqual([['session-1']]);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(actions).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('copies the thread folder, branch and ID, and marks it unread', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onMarkUnread = vi.fn();
    render(<ThreadsSessionItem session={buildSession({ cwd: '/work/app' })} branch="main" onMarkUnread={onMarkUnread} />);
    for (const action of ['Copy folder path', 'Copy branch name', 'Copy thread ID', 'Mark as unread']) {
      fireEvent.click(screen.getByRole('button', { name: 'Thread actions for Old title' }));
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: action })); });
    }
    await waitFor(() => expect(onMarkUnread).toHaveBeenCalled());
    expect([writeText.mock.calls, onMarkUnread.mock.calls]).toEqual([[['/work/app'], ['main'], ['session-1']], [['session-1']]]);
  });

  it('supports context-menu keys and returns focus after Escape', async () => {
    const user = userEvent.setup();
    render(<ThreadsSessionItem session={buildSession()} />);
    const select = screen.getByRole('button', { name: 'Select Old title' });
    select.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu', {name: 'Actions for Old title'})).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', {name: 'Close session'})).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(select).toHaveFocus();
  });

  it('cancels a rename without changing the session or selecting it', async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    const onSelect = vi.fn();
    render(<ThreadsSessionItem session={buildSession()} onRenameSession={onRenameSession} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', {name: 'Thread actions for Old title'}));
    await user.click(screen.getByRole('menuitem', {name: 'Rename session'}));
    await user.clear(screen.getByRole('textbox', {name: 'Thread title'}));
    await user.type(screen.getByRole('textbox', {name: 'Thread title'}), 'Discarded{Escape}');
    expect(screen.getByRole('button', {name: 'Select Old title'})).toHaveFocus();
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers unpin and unarchive for a pinned archived thread without selecting it', async () => {
    const user = userEvent.setup();
    const onUnpin = vi.fn();
    const onUnarchive = vi.fn();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<ThreadsSessionItem session={buildSession({thread: {pinned: true, archived: true}})} onUnpin={onUnpin} onUnarchive={onUnarchive} onClose={onClose} onSelect={onSelect} />);
    for (const action of ['Unpin', 'Unarchive', 'Close session']) {
      await user.click(screen.getByRole('button', {name: 'Thread actions for Old title'}));
      await user.click(screen.getByRole('menuitem', {name: action}));
    }
    expect([onUnpin.mock.calls, onUnarchive.mock.calls, onClose.mock.calls, onSelect.mock.calls]).toEqual([[['session-1']], [['session-1']], [['session-1']], []]);
  });
});


describe('ThreadsSessionItem actions and metadata', () => {
  it('catches a rejected rename, lets the draft change, and saves the corrected value', async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn().mockRejectedValueOnce(new Error('Rename denied')).mockResolvedValueOnce(undefined);
    render(<ThreadsSessionItem session={buildSession()} onRenameSession={onRenameSession} />);
    await user.dblClick(screen.getByRole('button', {name: 'Select Old title'}));
    const input = screen.getByRole('textbox', {name: 'Thread title'});
    await user.clear(input);
    await user.type(input, 'First draft{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Rename denied');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.clear(input);
    await user.type(input, 'Corrected draft{Enter}');
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'First draft'], ['session-1', 'Corrected draft']]);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Select Old title'})).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['rejected promise', 'synchronous throw'])('catches a menu %s and clears feedback after retry', async failureMode => {
    const user = userEvent.setup();
    const error = new Error('Pin denied');
    const onPin = vi.fn().mockImplementationOnce(() => {
      if (failureMode === 'synchronous throw') throw error;
      return Promise.reject(error);
    }).mockResolvedValueOnce(undefined);
    render(<ThreadsSessionItem session={buildSession()} onPin={onPin} />);
    await user.click(screen.getByRole('button', {name: 'Thread actions for Old title'}));
    await user.click(screen.getByRole('menuitem', {name: 'Pin'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pin denied');
    await user.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onPin.mock.calls).toEqual([['session-1'], ['session-1']]);
  });

  it('preserves a pending rename across Escape and double click without taking focus after an async blur save', async () => {
    const user = userEvent.setup();
    let finishRename;
    const onRenameSession = vi.fn(() => new Promise(resolve => { finishRename = resolve; }));
    render(<><ThreadsSessionItem session={buildSession()} onRenameSession={onRenameSession} /><button>Next control</button></>);
    await user.dblClick(screen.getByRole('button', {name: 'Select Old title'}));
    const input = screen.getByRole('textbox', {name: 'Thread title'});
    await user.clear(input);
    await user.type(input, 'Saved draft{Enter}{Escape}');
    expect(input).toHaveValue('Saved draft');
    expect(input).toHaveAttribute('readonly');
    fireEvent.doubleClick(input.closest('.threads-session-item'));
    expect(input).toHaveValue('Saved draft');
    await user.click(screen.getByRole('button', {name: 'Next control'}));
    await act(async () => finishRename());
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Saved draft']]);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Next control'})).toHaveFocus();
  });

  it('retains the rename draft after failure and retries without duplicate pending submissions', async () => {
    const user = userEvent.setup();
    let finishRename;
    const onRenameSession = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishRename = resolve; }))
      .mockResolvedValueOnce(undefined);
    render(<ThreadsSessionItem session={buildSession()} onRenameSession={onRenameSession} />);
    await user.dblClick(screen.getByRole('button', {name: 'Select Old title'}));
    const input = screen.getByRole('textbox', {name: 'Thread title'});
    await user.clear(input);
    await user.type(input, 'Retained draft{Enter}');
    expect(screen.getByRole('textbox', {name: 'Thread title'})).toHaveValue('Retained draft');
    fireEvent.keyDown(input, {key: 'Enter'});
    fireEvent.blur(input);
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Retained draft']]);
    await act(async () => finishRename({ok: false, error: new Error('Rename unavailable')}));
    expect(screen.getByRole('alert')).toHaveTextContent('Rename unavailable');
    expect(input).toHaveValue('Retained draft');
    await user.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.getByRole('button', {name: 'Select Old title'})).toHaveFocus();
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Retained draft'], ['session-1', 'Retained draft']]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['Pin', 'onPin', {}],
    ['Unpin', 'onUnpin', {pinned: true}],
    ['Archive', 'onArchive', {}],
    ['Unarchive', 'onUnarchive', {archived: true}],
    ['Close session', 'onClose', {}],
  ])('reports %s failure and allows one retry while preserving selection', async (label, callback, thread) => {
    const user = userEvent.setup();
    let finishAction;
    const action = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishAction = resolve; }))
      .mockResolvedValueOnce(undefined);
    const onSelect = vi.fn();
    render(<ThreadsSessionItem session={buildSession({thread})} onSelect={onSelect} {...{[callback]: action}} />);
    const actions = screen.getByRole('button', {name: 'Thread actions for Old title'});
    await user.click(actions);
    await user.click(screen.getByRole('menuitem', {name: label}));
    expect(actions).toBeDisabled();
    await user.click(actions);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await act(async () => finishAction({ok: false, error: new Error('Action unavailable')}));
    expect(screen.getByRole('alert')).toHaveTextContent('Action unavailable');
    await user.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect([action.mock.calls, onSelect.mock.calls]).toEqual([[['session-1'], ['session-1']], []]);
    expect(actions).toBeEnabled();
  });

  it('commits a rename on blur without taking focus from the next control', async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    render(<><ThreadsSessionItem session={buildSession()} onRenameSession={onRenameSession} /><button>Next control</button></>);
    await user.click(screen.getByRole('button', {name: 'Thread actions for Old title'}));
    await user.click(screen.getByRole('menuitem', {name: 'Rename session'}));
    await user.clear(screen.getByRole('textbox', {name: 'Thread title'}));
    await user.type(screen.getByRole('textbox', {name: 'Thread title'}), '  Saved title  ');
    const next = screen.getByRole('button', {name: 'Next control'});
    await user.click(next);
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Saved title']]);
    expect(next).toHaveFocus();
  });

  it('dismisses actions on an outside click without changing session state', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<><ThreadsSessionItem session={buildSession()} onClose={onClose} onSelect={onSelect} /><button>Outside</button></>);
    await user.click(screen.getByRole('button', {name: 'Thread actions for Old title'}));
    const outside = screen.getByRole('button', {name: 'Outside'});
    await user.click(outside);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
    expect([onClose.mock.calls, onSelect.mock.calls]).toEqual([[], []]);
  });

  it('uses last activity for the timestamp and omits invalid dates', () => {
    const updatedAt = '2026-10-24T18:00:00.000Z';
    const {rerender, container} = render(<ThreadsSessionItem session={buildSession({updatedAt})} />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', updatedAt);
    rerender(<ThreadsSessionItem session={buildSession({updatedAt: 'invalid'})} />);
    expect(container.querySelector('time')).not.toBeInTheDocument();
  });
});
