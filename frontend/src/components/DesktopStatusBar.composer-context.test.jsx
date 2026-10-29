import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import { addContext, buildTerminalContext, buildThreadContext, splitContext } from './composer-context/composerContext';
import { addTerminalSelectionToDraft } from './composer-context/terminalSelection';
import { readPromptHistory } from './composer-context/promptHistory';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { useComposerDraft } from '../hooks/useComposerDraft';

vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const threads = [{ id: 'thr_1', title: 'Fix login bug' }, { id: 'thr_2', title: 'Refactor billing' }];
const terminal = buildTerminalContext({ text: 'npm test\nFAIL auth', label: 'Terminal' });

function Harness({ initial = '', submit, sessionId = 's1', mentionThreads = threads }) {
  const [value, setValue] = useState(initial);
  return <DesktopStatusBar sessionId={sessionId} composerValue={value} onComposerChange={setValue} onComposerSubmit={text => { submit(text); setValue(''); }}
    mentionThreads={mentionThreads} showMicButtons={false} />;
}
const box = () => screen.getByRole('textbox', { name: 'Command composer' });

beforeEach(() => { localStorage.clear(); setActiveEnvironment(null); });

describe('inline composer context', () => {
  it('shows chips outside the textarea and sends the explicit reference text', () => {
    const submit = vi.fn();
    render(<Harness initial={addContext('why does this fail', terminal)} submit={submit} />);
    expect(box()).toHaveValue('why does this fail');
    expect(screen.getByRole('list', { name: 'Attached context' })).toHaveTextContent('Terminal · lines 1-2');
    fireEvent.keyDown(box(), { key: 'Enter' });
    const sent = submit.mock.calls[0][0];
    expect(splitContext(sent)).toMatchObject({ text: 'why does this fail', chips: [{ kind: 'terminal', body: 'npm test\nFAIL auth' }] });
  });

  it('redacts secrets in chip bodies at send time', () => {
    const submit = vi.fn();
    const leaky = { ...terminal, body: 'export API_KEY=supersecretvalue123' };
    render(<Harness initial={addContext('go', leaky)} submit={submit} />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(submit.mock.calls[0][0]).toContain('API_KEY=[redacted]');
    expect(submit.mock.calls[0][0]).not.toContain('supersecretvalue123');
  });

  it('removes a chip with its button', () => {
    const submit = vi.fn();
    render(<Harness initial={addContext('hi', terminal)} submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove terminal context/ }));
    expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull();
    expect(box()).toHaveValue('hi');
  });

  it('inserts a thread reference from an @ mention of the own thread list', () => {
    const submit = vi.fn();
    render(<Harness submit={submit} />);
    fireEvent.change(box(), { target: { value: 'see @login' } });
    fireEvent.click(screen.getByRole('option', { name: /Fix login bug/ }));
    expect(screen.getByRole('list', { name: 'Attached context' })).toHaveTextContent('Fix login bug');
    expect(box()).toHaveValue('see ');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(splitContext(submit.mock.calls[0][0]).chips).toMatchObject([{ kind: 'thread', id: 'thr_1' }]);
  });

  it('offers only threads from the supplied owner list', () => {
    render(<Harness submit={vi.fn()} mentionThreads={[]} />);
    fireEvent.change(box(), { target: { value: '@thr' } });
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('blocks sending a thread reference that is no longer in the owner list', () => {
    const submit = vi.fn();
    const stale = addContext('x', buildThreadContext({ id: 'other_user_thread', title: 'Not mine' }));
    render(<Harness initial={stale} submit={submit} />);
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Remove unavailable');
  });
});

describe('prompt history', () => {
  it('recalls sent prompts with up and down in an empty composer', () => {
    const submit = vi.fn();
    render(<Harness submit={submit} />);
    for (const text of ['first', 'second']) {
      fireEvent.change(box(), { target: { value: text } });
      fireEvent.keyDown(box(), { key: 'Enter' });
    }
    expect(readPromptHistory('s1')).toEqual(['first', 'second']);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('second');
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('first');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box()).toHaveValue('second');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box()).toHaveValue('');
  });

  it('does not hijack arrows when the composer has typed text', () => {
    render(<Harness submit={vi.fn()} />);
    fireEvent.change(box(), { target: { value: 'one' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.change(box(), { target: { value: 'typing' } });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box()).toHaveValue('typing');
  });
});

function DraftHarness({ sessionId }) {
  const draft = useComposerDraft(sessionId);
  return <DesktopStatusBar sessionId={sessionId} composerValue={draft.value} onComposerChange={draft.setValue} onComposerSubmit={() => {}} showMicButtons={false} />;
}

describe('draft retention', () => {
  it('keeps terminal chips through remount, and isolates them by session and environment', async () => {
    expect(addTerminalSelectionToDraft('s1', 'build failed\nexit 1', 'Thread terminal')).toBe(true);
    const first = render(<DraftHarness sessionId="s1" />);
    expect(screen.getByRole('list', { name: 'Attached context' })).toHaveTextContent('Thread terminal · lines 1-2');
    first.unmount();
    const second = render(<DraftHarness sessionId="s1" />);
    expect(screen.getByRole('list', { name: 'Attached context' })).toBeInTheDocument();
    second.unmount();
    const other = render(<DraftHarness sessionId="s2" />);
    expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull();
    other.unmount();
    render(<DraftHarness sessionId="s1" />);
    setActiveEnvironment({ id: 'env-b' });
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull());
    setActiveEnvironment(null);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Attached context' })).toBeInTheDocument());
    expect(splitContext(getComposerDraftStore('s1').getSnapshot().text).chips).toHaveLength(1);
  });

  it('ignores blank terminal selections', () => {
    expect(addTerminalSelectionToDraft('s9', '   \n', 'T')).toBe(false);
  });
});
