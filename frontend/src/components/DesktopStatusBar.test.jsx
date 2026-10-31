import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import AttachmentDraftStatus from './AttachmentDraftStatus';
import { useComposerFileAttachments } from '../hooks/useComposerFileAttachments';
import { captureAuthScope, clearTokens, setUser } from '../utils/auth';
import { getEnvironmentCacheScope, getEnvironmentSignal } from '../utils/remoteEnvironments';
import { setComposerScrollPreference } from '../utils/composerScrollPreference';
import { createTransferReviewStore } from '../utils/transferReviewStore';

const toggleAutocorrectMock = vi.fn();
const mockMicCallbacks = new Map();
const { mobileDetectMock } = vi.hoisted(() => ({ mobileDetectMock: vi.fn(() => false) }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: mobileDetectMock }));

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: true,
    toggleAutocorrect: toggleAutocorrectMock
  })
}));

vi.mock('./TerminalMicButton', () => ({
  TerminalMicButton: ({ provider, onTranscript }) => {
    mockMicCallbacks.set(provider, onTranscript);
    return <button
      type="button"
      data-testid={`terminal-mic-mock-${provider}`}
      onClick={() => onTranscript?.(`${provider} transcript`)}
    />;
  }
}));

const uploadScreenshotMock = vi.fn();
const getImageFileFromDataTransferMock = vi.fn();
const getSpellCheckerMock = vi.fn();
const getAutocorrectSuggestionMock = vi.fn();

const uploadAttachmentMock = vi.fn();
vi.mock('../utils/api', () => ({
  uploadScreenshot: (...args) => uploadScreenshotMock(...args),
  uploadAttachment: (...args) => uploadAttachmentMock(...args)
}));

vi.mock('../utils/clipboardImage', () => ({
  getImageFileFromDataTransfer: (...args) => getImageFileFromDataTransferMock(...args)
}));

vi.mock('../utils/autocorrect', () => ({
  getSpellChecker: (...args) => getSpellCheckerMock(...args),
  getAutocorrectSuggestion: (...args) => getAutocorrectSuggestionMock(...args)
}));

function buildProps(overrides = {}) {
  return {
    sessionId: 'session-1',
    sessionTitle: 'Terminal 1',
    cwd: 'C:\\Users\\conor\\project',
    gitBranch: 'main',
    customAiProviders: [],
    composerValue: '',
    composerAttachments: [],
    onComposerChange: vi.fn(),
    onComposerSubmit: vi.fn(),
    onComposerAttachmentAdd: vi.fn(),
    onComposerAttachmentRemove: vi.fn(),
    isTerminalPanelOpen: false,
    onToggleTerminalPanel: vi.fn(),
    connectionState: 'online',
    ...overrides
  };
}

describe('DesktopStatusBar', () => {
  it('compacts on a real timeline scroll and expands for editing without changing the draft', () => {
    mobileDetectMock.mockReturnValue(false);
    const onComposerChange = vi.fn();
    const props = buildProps({ compactConversation: true, composerValue: 'Keep my draft', onComposerChange });
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread"><p>Conversation</p></div><DesktopStatusBar {...props} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).toHaveClass('scroll-compact');
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my draft');
    fireEvent.focus(screen.getByRole('textbox', { name: 'Command composer' }));
    expect(shell).not.toHaveClass('scroll-compact');
    expect(onComposerChange).not.toHaveBeenCalled();
  });

  it('does not compact a phone, a narrow pane, multiline text, or a timeline already at its end', () => {
    mobileDetectMock.mockReturnValue(false);
    const props = buildProps({ compactConversation: true });
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...props} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 800, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: 30 });
    expect(shell).not.toHaveClass('scroll-compact');
    thread.scrollTop = 600;
    shell.getBoundingClientRect = () => ({ width: 500 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
    shell.getBoundingClientRect = () => ({ width: 800 });
    view.rerender(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...props} composerValue={'First line\nSecond line'} /></div>);
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
    mobileDetectMock.mockReturnValue(true);
    view.rerender(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...props} /></div>);
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
  });

  it('compacts for timeline keyboard navigation while retaining visible attachments and nested scrolling', () => {
    mobileDetectMock.mockReturnValue(false);
    const props = buildProps({ compactConversation: true });
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread" tabIndex={0}><div data-testid="nested" style={{ overflowY: 'auto' }}>Nested content</div></div><DesktopStatusBar {...props} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    const nested = screen.getByTestId('nested');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    Object.defineProperties(nested, { scrollHeight: { value: 500 }, clientHeight: { value: 100 }, scrollTop: { value: 100, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(nested, { deltaY: -30 });
    fireEvent.keyDown(nested, { key: 'PageUp' });
    expect(shell).not.toHaveClass('scroll-compact');
    fireEvent.keyDown(thread, { key: 'PageUp' });
    expect(shell).toHaveClass('scroll-compact');
    thread.scrollTop = 800;
    fireEvent.scroll(thread);
    expect(shell).not.toHaveClass('scroll-compact');
    thread.scrollTop = 600;
    view.rerender(<div className="desktop-terminal-stack"><div className="desktop-thread" tabIndex={0}><div data-testid="nested" style={{ overflowY: 'auto' }}>Nested content</div></div><DesktopStatusBar {...props} composerAttachments={[{ path: '/tmp/example', name: 'example' }]} /></div>);
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
    expect(screen.getByLabelText('Composer attachments')).toBeVisible();
  });

  it('does not compact beneath an open model control even when focus is outside the composer', () => {
    mobileDetectMock.mockReturnValue(false);
    const props = buildProps({ compactConversation: true, composerPrimaryAction: <button type="button" aria-expanded="true">Model</button> });
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...props} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
  });

  it('immediately expands and stops compacting when the scrolling preference is disabled in another tab', () => {
    localStorage.removeItem('tv4.composerCollapseOnScroll');
    mobileDetectMock.mockReturnValue(false);
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...buildProps({ compactConversation: true })} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).toHaveClass('scroll-compact');
    localStorage.setItem('tv4.composerCollapseOnScroll', 'false');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'tv4.composerCollapseOnScroll', newValue: 'false' })));
    expect(shell).not.toHaveClass('scroll-compact');
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
    view.unmount();
    localStorage.removeItem('tv4.composerCollapseOnScroll');
  });

  it('updates open composers immediately when the preference changes in this tab', () => {
    localStorage.removeItem('tv4.composerCollapseOnScroll');
    mobileDetectMock.mockReturnValue(false);
    const view = render(<div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...buildProps({ compactConversation: true })} /></div>);
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).toHaveClass('scroll-compact');
    act(() => { setComposerScrollPreference(false); });
    expect(shell).not.toHaveClass('scroll-compact');
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).not.toHaveClass('scroll-compact');
    act(() => { setComposerScrollPreference(true); });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).toHaveClass('scroll-compact');
    view.unmount();
    localStorage.removeItem('tv4.composerCollapseOnScroll');
  });

  it('expands a compact composer when its model menu opens', async () => {
    mobileDetectMock.mockReturnValue(false);
    const props = buildProps({ compactConversation: true });
    const content = open => <div className="desktop-terminal-stack"><div className="desktop-thread">Conversation</div><DesktopStatusBar {...props} composerPrimaryAction={<button type="button" aria-expanded={open}>Model</button>} /></div>;
    const view = render(content(false));
    const thread = view.container.querySelector('.desktop-thread');
    const shell = view.container.querySelector('.status-composer-shell');
    Object.defineProperties(thread, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 }, scrollTop: { value: 600, writable: true } });
    shell.getBoundingClientRect = () => ({ width: 800 });
    fireEvent.wheel(thread, { deltaY: -30 });
    expect(shell).toHaveClass('scroll-compact');
    view.rerender(content(true));
    await waitFor(() => expect(shell).not.toHaveClass('scroll-compact'));
  });

  it.each(['isInterrupting', 'requiresCleanup'])('keeps typed and slash-command Enter behind the %s cancellation gate', gate => {
    const props = buildProps({ [gate]: true, composerValue: 'Keep this unsent follow-up', onInterrupt: vi.fn() });
    const view = render(<DesktopStatusBar {...props} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    view.rerender(<DesktopStatusBar {...props} aiType="codex" composerValue="/mod" />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    expect(props.onComposerSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('/mod');
  });

  it('lets Shift+Tab leave slash suggestions without changing or submitting the draft', () => {
    const props = buildProps({ aiType: 'codex', composerValue: '/mod' });
    render(<DesktopStatusBar {...props} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true);
    expect([props.onComposerChange.mock.calls, props.onComposerSubmit.mock.calls]).toEqual([[], []]);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(props.onComposerChange).toHaveBeenCalledWith('/model ');
  });

  it('returns focus to the composer after choosing a slash suggestion for arguments', () => {
    const props = buildProps({ aiType: 'codex', composerValue: '/mod' });
    render(<DesktopStatusBar {...props} />);
    const option = screen.getByRole('option', { name: /\/model/ });
    option.focus();
    fireEvent.click(option);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveFocus();
    expect(props.onComposerChange).toHaveBeenCalledWith('/model ');
    expect(props.onComposerSubmit).not.toHaveBeenCalled();
  });

  it('provides a multiline mobile typing field and focuses it when the composer surface is tapped', () => {
    mobileDetectMock.mockReturnValue(true);
    render(<DesktopStatusBar {...buildProps()} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    expect(input).toHaveAttribute('rows', '1');
    expect(input).toHaveAttribute('enterkeyhint', 'enter');
    fireEvent.click(input.closest('form'));
    expect(input).toHaveFocus();
  });

  it('offers direct automatic dictation while retaining explicit provider choices and the draft', () => {
    mobileDetectMock.mockReturnValue(true);
    const onComposerChange = vi.fn();
    const { container } = render(<DesktopStatusBar {...buildProps({ compactInputOptions: true, composerValue: 'Existing draft', onComposerChange })} />);
    const direct = screen.getByTestId('terminal-mic-mock-undefined');
    expect(direct.closest('.composer-input-options')).toBeNull();
    const options = container.querySelector('.composer-input-options');
    options.open = true;
    expect(options).toContainElement(screen.getByTestId('terminal-mic-mock-local'));
    expect(options).toContainElement(screen.getByTestId('terminal-mic-mock-groq'));
    fireEvent.click(direct);
    expect(onComposerChange).toHaveBeenCalledWith('Existing draft undefined transcript');
  });

  it('appends a completed recording to the latest draft rather than the draft at recording start', () => {
    mobileDetectMock.mockReturnValue(true);
    const onComposerChange = vi.fn();
    const props = buildProps({ compactInputOptions: true, composerValue: 'Original', onComposerChange });
    const view = render(<DesktopStatusBar {...props} />);
    const completedRecording = mockMicCallbacks.get(undefined);
    view.rerender(<DesktopStatusBar {...props} composerValue="Original, edited while recording" />);
    completedRecording('Dictated words');
    expect(onComposerChange).toHaveBeenCalledWith('Original, edited while recording Dictated words');
    onComposerChange.mockClear();
    view.rerender(<DesktopStatusBar {...props} composerDisabled />);
    completedRecording('Kept while disabled');
    expect(onComposerChange).toHaveBeenCalledExactlyOnceWith('Original Kept while disabled');
    onComposerChange.mockClear();
    view.rerender(<DesktopStatusBar {...props} sessionId="another-session" />);
    completedRecording('Ignored after switching sessions');
    expect(onComposerChange).not.toHaveBeenCalled();
  });

  it('leaves mobile Return available for a newline and sends only through Send or a keyboard shortcut', () => {
    mobileDetectMock.mockReturnValue(true);
    const props = buildProps({ composerValue: 'Keep writing on a new line' });
    render(<DesktopStatusBar {...props} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect(props.onComposerSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(props.onComposerSubmit.mock.calls).toEqual([['Keep writing on a new line']]);
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal', exact: true }));
    expect(props.onComposerSubmit).toHaveBeenCalledTimes(2);
  });
  it('keeps the draft and stops a response from the composer without submitting it', () => {
    const interrupt = vi.fn();
    const submit = vi.fn();
    const props = buildProps({ composerValue: 'Unsent follow-up', isStreaming: true, onInterrupt: interrupt, onComposerSubmit: submit });
    const view = render(<DesktopStatusBar {...props} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    const stop = screen.getByRole('button', { name: 'Stop response', exact: true });
    expect(stop.closest('form')).toContainElement(input);
    expect(screen.getByRole('button', { name: 'Send to terminal', exact: true })).toBeEnabled();
    fireEvent.click(stop);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(input).toHaveValue('Unsent follow-up');
    view.rerender(<DesktopStatusBar {...props} isStreaming={false} />);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toBe(input);
    expect(screen.getByRole('button', { name: 'Send to terminal', exact: true })).toBeEnabled();
  });

  it('keeps cancellation retry available when sending is disabled and blocks repeated cancellation', () => {
    const interrupt = vi.fn();
    const props = buildProps({ composerDisabled: true, requiresCleanup: true, onInterrupt: interrupt });
    const view = render(<DesktopStatusBar {...props} />);
    expect(screen.getByRole('button', { name: 'Retry cancellation', exact: true })).toHaveTextContent('Retry cancellation');
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation', exact: true }));
    expect(interrupt).toHaveBeenCalledTimes(1);
    view.rerender(<DesktopStatusBar {...props} isInterrupting />);
    expect(screen.getByRole('button', { name: 'Stopping response', exact: true })).toBeDisabled();
    view.rerender(<DesktopStatusBar {...props} onInterrupt={undefined} />);
    expect(screen.getByRole('button', { name: 'Retry cancellation', exact: true })).toBeDisabled();
  });

  it('navigates the AI menu by keyboard and returns focus to its trigger on Escape', () => {
    const select = vi.fn();
    render(<DesktopStatusBar {...buildProps({ aiType: 'claude', onSelectAiType: select,
      aiOptions: [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }] })} />);
    const trigger = screen.getByRole('button', { name: 'Choose AI coder' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Claude' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemradio', { name: 'Codex' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'AI coder options' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps attachments unchanged while submission disables the composer', () => {
    const remove = vi.fn();
    render(<DesktopStatusBar {...buildProps({ composerDisabled: true,
      composerAttachments: [{ path: '/attachment', name: 'draft.png' }], onComposerAttachmentRemove: remove })} />);
    const button = screen.getByRole('button', { name: 'Remove draft.png' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });

  it('groups mobile secondary actions and restores focus when Escape closes them', () => {
    const { container } = render(<DesktopStatusBar {...buildProps({
      compactInputOptions: true,
      composerSecondaryAction: <button type="button">Workspace tools fixture</button>
    })} />);
    const trigger = screen.getByLabelText('More composer actions');
    const options = trigger.closest('details');
    options.open = true;
    expect(container.querySelector('.composer-input-options-menu')).toContainElement(screen.getByRole('button', { name: 'Workspace tools fixture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable autocorrect' }));
    expect(toggleAutocorrectMock).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(options, { key: 'Escape' });
    expect(options.open).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it('shows the last reported phone context reading without changing the More control name', () => {
    render(<DesktopStatusBar {...buildProps({ compactInputOptions: true,
      composerContext: { percent: 25, detail: '50,000 of 200,000 tokens' } })} />);
    const more = screen.getByLabelText('More composer actions');
    expect(more).toHaveTextContent('25%');
    expect(more).toHaveAccessibleDescription('Last provider-reported context: 50,000 of 200,000 tokens.');
    fireEvent.click(more);
    expect(screen.getAllByText('Last provider-reported context: 50,000 of 200,000 tokens.').some(element => element.closest('.composer-input-options-menu'))).toBe(true);
  });

  it('keeps session context and branch switching reachable through compact mobile actions', () => {
    mobileDetectMock.mockReturnValue(true);
    const onSelectGitBranch = vi.fn();
    render(<DesktopStatusBar {...buildProps({ compactInputOptions: true, composerValue: 'Unsent draft',
      gitBranches: ['main', 'feature/ui'], currentGitBranch: 'main', onSelectGitBranch })} />);
    const more = screen.getByLabelText('More composer actions');
    const options = more.closest('details');
    fireEvent.click(more);
    const context = screen.getByRole('button', { name: 'Session context', exact: true });
    expect(options).toContainElement(context);
    fireEvent.click(context);
    const dialog = screen.getByRole('dialog', { name: 'Session context' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Select git branch' }), { target: { value: 'feature/ui' } });
    expect(onSelectGitBranch).toHaveBeenCalledWith('feature/ui');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(context).toHaveFocus();
    expect(options.open).toBe(true);
    fireEvent.keyDown(context, { key: 'Escape' });
    expect(more).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Unsent draft');
  });

  it('dismisses secondary actions outside while preserving a portal action and the draft', async () => {
    render(<DesktopStatusBar {...buildProps({ compactInputOptions: true, composerValue: 'Keep this draft' })} />);
    const details = screen.getByLabelText('More composer actions').closest('details');
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(details.open).toBe(true));
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      fireEvent.pointerDown(dialog);
      expect(details.open).toBe(true);
      fireEvent.pointerDown(document.body);
      expect(details.open).toBe(false);
      expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep this draft');
    } finally { dialog.remove(); }
  });

  it('lets users draft while task submission is disabled by missing launch choices', () => {
    const onComposerSubmit = vi.fn();
    render(<DesktopStatusBar sessionId="start" composerValue="Fix the build" onComposerChange={vi.fn()} onComposerSubmit={onComposerSubmit} composerSubmitDisabled composerSubmitLabel="Start task" />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    expect(input).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onComposerSubmit).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key));
    mobileDetectMock.mockReturnValue(false);
    toggleAutocorrectMock.mockClear();
    uploadScreenshotMock.mockReset();
    uploadAttachmentMock.mockReset();
    getImageFileFromDataTransferMock.mockReset();
    getSpellCheckerMock.mockReset();
    getAutocorrectSuggestionMock.mockReset();
    getSpellCheckerMock.mockResolvedValue({ correct: vi.fn(() => false), suggest: vi.fn(() => ['the']) });
    getAutocorrectSuggestionMock.mockImplementation((_spell, word) => (word === 'teh' ? 'the' : null));
    vi.restoreAllMocks();
  });

  it('marks terminal panel button active when panel is open', () => {
    render(<DesktopStatusBar {...buildProps({ isTerminalPanelOpen: true })} />);
    expect(screen.getByRole('button', { name: 'Hide inline terminal panel' })).toHaveClass('active');
  });

  it('toggles inline terminal panel', () => {
    const onToggleTerminalPanel = vi.fn();
    render(<DesktopStatusBar {...buildProps({ onToggleTerminalPanel })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show inline terminal panel' }));

    expect(onToggleTerminalPanel).toHaveBeenCalledTimes(1);
  });

  it('hides the terminal toggle when terminal-first mode is active', () => {
    render(<DesktopStatusBar {...buildProps({ showTerminalToggle: false })} />);
    expect(screen.queryByRole('button', { name: 'Show inline terminal panel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide inline terminal panel' })).not.toBeInTheDocument();
  });

  it('shows a segmented control for Codex UI and raw terminal mode', () => {
    const onToggleTerminalViewMode = vi.fn();
    render(<DesktopStatusBar {...buildProps({
      showTerminalToggle: false,
      showTerminalViewModeToggle: true,
      terminalViewMode: 'codex',
      onToggleTerminalViewMode
    })} />);

    expect(screen.getByRole('group', { name: 'Terminal view mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Codex UI' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Show Raw Terminal' }));

    expect(onToggleTerminalViewMode).toHaveBeenCalledWith('terminal');
  });

  it('marks the raw terminal mode option active', () => {
    render(<DesktopStatusBar {...buildProps({
      showTerminalToggle: false,
      showTerminalViewModeToggle: true,
      terminalViewMode: 'terminal'
    })} />);

    expect(screen.getByRole('button', { name: 'Show Raw Terminal' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Show Raw Terminal' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls autocorrect toggle when autocorrect button is pressed', () => {
    render(<DesktopStatusBar {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable autocorrect' }));
    expect(toggleAutocorrectMock).toHaveBeenCalledTimes(1);
  });

  it('shows the DeepSeek API provider label in the footer', () => {
    render(<DesktopStatusBar {...buildProps({ aiType: 'deepseek' })} />);
    expect(screen.getByRole('button', { name: 'Choose AI coder' })).toHaveAttribute('title', 'Assistant: DeepSeek');
  });

  it('lets the user choose a different AI coder from the footer menu', () => {
    const onSelectAiType = vi.fn();
    render(<DesktopStatusBar {...buildProps({ aiType: 'claude', onSelectAiType })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose AI coder' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Codex' }));

    expect(onSelectAiType).toHaveBeenCalledWith('codex');
  });

  it('captures a custom command from the footer menu', () => {
    const onAddCustomAiCommand = vi.fn();
    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('Qwen 3')
      .mockReturnValueOnce('qwen --fast');

    render(<DesktopStatusBar {...buildProps({ onAddCustomAiCommand })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose AI coder' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add custom command' }));

    expect(promptSpy).toHaveBeenCalledTimes(2);
    expect(onAddCustomAiCommand).toHaveBeenCalledWith('Qwen 3', 'qwen --fast');
  });

  it('submits composer text when Enter is pressed', () => {
    const onComposerSubmit = vi.fn();
    render(<DesktopStatusBar {...buildProps({ composerValue: 'Explain this repo', onComposerSubmit })} />);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });

    expect(onComposerSubmit).toHaveBeenCalledWith('Explain this repo');
  });

  it('submits the live textarea value when parent state is behind', () => {
    const onComposerSubmit = vi.fn();
    render(<DesktopStatusBar {...buildProps({ composerValue: '', onComposerSubmit })} />);

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter.call(composer, 'fast typed prompt');
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(onComposerSubmit).toHaveBeenCalledWith('fast typed prompt');
  });

  it('autocorrects misspelled words in the Ask V4 composer on space', async () => {
    const onComposerChange = vi.fn();
    render(<DesktopStatusBar {...buildProps({ composerValue: 'teh', onComposerChange })} />);

    await waitFor(() => {
      expect(getSpellCheckerMock).toHaveBeenCalledTimes(1);
    });

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.keyDown(composer, {
      key: ' ',
      target: { selectionStart: 3 }
    });

    expect(onComposerChange).toHaveBeenCalledWith('the ');
  });

  it('clears pending autocorrect undo when the caret moves', async () => {
    function Wrapper() {
      const [composerValue, setComposerValue] = useState('teh');
      return (
        <DesktopStatusBar
          {...buildProps({
            composerValue,
            onComposerChange: setComposerValue
          })}
        />
      );
    }

    render(<Wrapper />);

    await waitFor(() => {
      expect(getSpellCheckerMock).toHaveBeenCalledTimes(1);
    });

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.keyDown(composer, {
      key: ' ',
      target: { selectionStart: 3 }
    });

    await waitFor(() => {
      expect(composer).toHaveValue('the ');
    });

    fireEvent.select(composer, {
      target: { selectionStart: 0, selectionEnd: 0 }
    });
    fireEvent.keyDown(composer, {
      key: 'Backspace',
      target: { selectionStart: 0, selectionEnd: 0 }
    });

    expect(composer).toHaveValue('the ');
  });

  it('routes mic transcripts into the AskV composer', () => {
    const onComposerChange = vi.fn();
    render(<DesktopStatusBar {...buildProps({ composerValue: 'Existing draft', onComposerChange })} />);

    fireEvent.click(screen.getByTestId('terminal-mic-mock-groq'));

    expect(onComposerChange).toHaveBeenCalledWith('Existing draft groq transcript');
  });

  it.each(['composerSubmitDisabled', 'composerDisabled'])('keeps slash-command Enter behind the %s gate', gate => {
    const onComposerSubmit = vi.fn();
    render(<DesktopStatusBar {...buildProps({ aiType: 'codex', composerValue: '/mod', [gate]: true, onComposerSubmit })} />);
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    expect(onComposerSubmit).not.toHaveBeenCalled();
  });

  it('suggests project files for an @ mention and inserts the chosen path', async () => {
    const onComposerChange = vi.fn();
    const files = ['src/login.js', 'src/logout.js'];
    vi.spyOn(globalThis, 'fetch');
    render(<DesktopStatusBar {...buildProps({ composerValue: 'Fix @log', onComposerChange, mentionRoot: '/work', mentionFiles: files })} />);
    expect(screen.getByRole('listbox', { name: 'File mentions' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    expect(onComposerChange.mock.calls).toEqual([['Fix @src/logout.js ']]);
  });

  it('attaches any kind of file when the conversation accepts files', async () => {
    const onComposerAttachmentAdd = vi.fn();
    uploadAttachmentMock.mockReset().mockResolvedValue('/home/me/terminal-v4-uploads/1/spec.pdf');
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    const input = view.container.querySelector('.status-composer-image-input');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    const file = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect([input.getAttribute('accept'), uploadAttachmentMock.mock.calls.length, onComposerAttachmentAdd.mock.calls]).toEqual([
      null, 1, [[{ name: 'spec.pdf', path: '/home/me/terminal-v4-uploads/1/spec.pdf' }]],
    ]);
  });

  it('attaches image formats that are not supported by the screenshot uploader as ordinary files', async () => {
    const onComposerAttachmentAdd = vi.fn();
    uploadAttachmentMock.mockResolvedValue('/fixture/diagram.svg');
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    const input = view.container.querySelector('.status-composer-image-input');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'diagram.svg', { type: 'image/svg+xml' })] } }); });
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'diagram.svg', path: '/fixture/diagram.svg' }]]);
    expect(uploadScreenshotMock).not.toHaveBeenCalled();
  });

  it('drops multiple files in order and blocks submission until their uploads finish', async () => {
    const onComposerAttachmentAdd = vi.fn(), onComposerSubmit = vi.fn();
    let finishFirst;
    uploadAttachmentMock.mockImplementation(() => new Promise(resolve => { finishFirst = resolve; }));
    uploadScreenshotMock.mockResolvedValue('/fixture/two.png');
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, composerValue: 'Keep my draft', onComposerAttachmentAdd, onComposerSubmit })} />);
    const files = [new File(['first'], 'one.txt', { type: 'text/plain' }), new File(['image'], 'two.png', { type: 'image/png' })];
    fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files, items: [] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    await act(async () => finishFirst('/fixture/one.txt'));
    await waitFor(() => expect(onComposerAttachmentAdd).toHaveBeenCalledTimes(2));
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'one.txt', path: '/fixture/one.txt' }], [{ name: 'two.png', path: '/fixture/two.png' }]]);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my draft');
    expect(onComposerSubmit).not.toHaveBeenCalled();
  });

  it('retains the upload recovery record until the selected file is saved', async () => {
    let finishSave;
    const waitForAttachmentPersistence = vi.fn(() => new Promise(resolve => { finishSave = resolve; }));
    uploadAttachmentMock.mockResolvedValue('/fixture/one.txt');
    const view = render(<DesktopStatusBar {...buildProps({ sessionId: 'pending-save', allowAnyFile: true, composerValue: 'Keep my draft', onComposerAttachmentAdd: vi.fn(), waitForAttachmentPersistence })} />);
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [new File(['a'], 'one.txt', { type: 'text/plain' })], items: [] } }); });
    await waitFor(() => expect(waitForAttachmentPersistence).toHaveBeenCalledOnce());
    expect(Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    await act(async () => finishSave(true));
    expect(Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });

  it('holds file selection for review if saving it cannot be confirmed', async () => {
    uploadAttachmentMock.mockResolvedValue('/fixture/one.txt');
    const view = render(<DesktopStatusBar {...buildProps({ sessionId: 'failed-save', allowAnyFile: true, composerValue: 'Keep my draft', onComposerAttachmentAdd: vi.fn(), waitForAttachmentPersistence: async () => false })} />);
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [new File(['a'], 'one.txt', { type: 'text/plain' })], items: [] } }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:'))).toHaveLength(1);
  });

  it('accepts multiple selected files for file-capable conversations', async () => {
    const onComposerAttachmentAdd = vi.fn();
    uploadAttachmentMock.mockImplementation(async file => `/fixture/${file.name}`);
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    const input = view.container.querySelector('.status-composer-image-input');
    expect(input).toHaveAttribute('multiple');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.pdf', { type: 'application/pdf' })] } }); });
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'one.txt', path: '/fixture/one.txt' }], [{ name: 'two.pdf', path: '/fixture/two.pdf' }]]);
  });

  it('pastes files and preserves pasted text at the current selection', async () => {
    const onComposerAttachmentAdd = vi.fn(), onComposerChange = vi.fn();
    uploadAttachmentMock.mockImplementation(async file => `/fixture/${file.name}`);
    render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, composerValue: 'left RIGHT tail', onComposerAttachmentAdd, onComposerChange })} />);
    const input = screen.getByRole('textbox', { name: 'Command composer' });
    input.setSelectionRange(5, 10);
    const files = [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.pdf', { type: 'application/pdf' })];
    await act(async () => { fireEvent.paste(input, { clipboardData: { files, items: [], getData: type => type === 'text/plain' ? 'pasted text' : '' } }); });
    expect(onComposerChange).toHaveBeenCalledExactlyOnceWith('left pasted text tail');
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'one.txt', path: '/fixture/one.txt' }], [{ name: 'two.pdf', path: '/fixture/two.pdf' }]]);
  });

  it('stops a batch if the file selection changes while an upload is pending', async () => {
    let selection = {}, finishFirst;
    const onComposerAttachmentAdd = vi.fn();
    uploadAttachmentMock.mockImplementation(() => new Promise(resolve => { finishFirst = resolve; }));
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd,
      getAttachmentSelectionToken: () => selection, isAttachmentSelectionTokenCurrent: value => value === selection })} />);
    const files = [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.txt', { type: 'text/plain' })];
    fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files, items: [] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    selection = {};
    await act(async () => finishFirst('/fixture/one.txt'));
    expect(uploadAttachmentMock).toHaveBeenCalledOnce();
    expect(onComposerAttachmentAdd).not.toHaveBeenCalled();
    expect(screen.getByText(/file selections changed/i)).toBeVisible();
  });

  it('rejects a second drop while a file batch is still uploading', async () => {
    let finish;
    uploadAttachmentMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onComposerAttachmentAdd = vi.fn();
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    const shell = view.container.querySelector('.status-composer-shell');
    const drop = name => fireEvent.drop(shell, { dataTransfer: { types: ['Files'], files: [new File(['a'], name, { type: 'text/plain' })], items: [] } });
    drop('first.txt');
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    drop('second.txt');
    expect(uploadAttachmentMock).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent(/wait.*upload/i);
    await act(async () => finish('/fixture/first.txt'));
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'first.txt', path: '/fixture/first.txt' }]]);
  });

  it('stops at a failed file and reports files already attached', async () => {
    const onComposerAttachmentAdd = vi.fn(), onComposerSubmit = vi.fn();
    uploadAttachmentMock.mockResolvedValueOnce('/fixture/one.txt').mockRejectedValueOnce(new Error('Synthetic upload failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, composerValue: 'Keep my draft', onComposerAttachmentAdd, onComposerSubmit })} />);
    const files = ['one.txt', 'two.txt', 'three.txt'].map(name => new File(['a'], name, { type: 'text/plain' }));
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files, items: [] } }); });
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);
    expect(onComposerAttachmentAdd.mock.calls).toEqual([[{ name: 'one.txt', path: '/fixture/one.txt' }]]);
    expect(screen.getByRole('alert')).toHaveTextContent(/Synthetic upload failed.*1 file was already attached/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    fireEvent.submit(view.container.querySelector('form'));
    expect(onComposerSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(onComposerSubmit).toHaveBeenCalledExactlyOnceWith('Keep my draft');
    consoleError.mockRestore();
  });

  it('rejects an oversized file batch before uploading any file', async () => {
    const onComposerAttachmentAdd = vi.fn();
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd })} />);
    const files = Array.from({ length: 101 }, (_, index) => new File(['a'], `${index}.txt`, { type: 'text/plain' }));
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files, items: [] } }); });
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/up to 100 files/i);
  });

  it('rejects a folder drop without uploading any files or changing the draft', async () => {
    const onComposerAttachmentAdd = vi.fn(), onComposerChange = vi.fn();
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, composerValue: 'Keep this', onComposerAttachmentAdd, onComposerChange })} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/folders.*cannot.*attached/i);
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(onComposerAttachmentAdd).not.toHaveBeenCalled();
    expect(onComposerChange).not.toHaveBeenCalled();
  });

  it('does not carry an incomplete file selection into a different session', async () => {
    const props = buildProps({ sessionId: 'first-session', allowAnyFile: true, composerValue: 'First draft' });
    const view = render(<DesktopStatusBar {...props} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } }); });
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    view.rerender(<DesktopStatusBar {...props} sessionId="next-session" composerValue="Next draft" />);
    expect(screen.queryByRole('button', { name: 'Continue with current files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Next draft');
  });

  it('restores an incomplete-selection hold when the composer remounts in the same session', async () => {
    const props = buildProps({ sessionId: 'review-session', allowAnyFile: true, composerValue: 'Keep my draft' });
    const view = render(<DesktopStatusBar {...props} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } }); });
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    view.unmount();
    render(<DesktopStatusBar {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/previous file selection.*check/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });

  it('keeps another tab\'s newer review after acknowledging the local selection', async () => {
    const props = buildProps({ sessionId: 'two-reviews', allowAnyFile: true, composerValue: 'Keep my draft' });
    const view = render(<DesktopStatusBar {...props} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } }); });
    const other = createTransferReviewStore({ sessionId: 'two-reviews', auth: captureAuthScope(), environment: getEnvironmentCacheScope(), signal: getEnvironmentSignal() });
    act(() => { expect(other.mark()).toBeTruthy(); });
    expect(screen.getByText(/1 other selection needs review/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/previous file selection.*check/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with current files' }));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });

  it('holds sending if saved selection warnings cannot be read on first open', () => {
    const length = vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => { throw new Error('storage unavailable'); });
    render(<DesktopStatusBar {...buildProps({ sessionId: 'review-unreadable', allowAnyFile: true, composerValue: 'Keep my draft' })} />);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/could not save or read the review warning/i);
    length.mockRestore();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeEnabled();
  });

  it('reports when the review warning cannot be saved on the device', async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('tv4:file-transfer-review:v1:')) throw new Error('storage unavailable');
      return original.call(this, key, value);
    });
    const view = render(<DesktopStatusBar {...buildProps({ sessionId: 'review-storage', allowAnyFile: true, composerValue: 'Keep my draft' })} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } }); });
    expect(screen.getByRole('status')).toHaveTextContent(/could not save.*keep this tab open/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
  });

  it('does not upload files when the recovery record cannot be saved', async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('tv4:file-transfer-review:v1:')) throw new Error('storage unavailable');
      return original.call(this, key, value);
    });
    const view = render(<DesktopStatusBar {...buildProps({ sessionId: 'claim-storage', allowAnyFile: true, composerValue: 'Keep my draft' })} />);
    const file = new File(['a'], 'one.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files: [file], items: [] } }); });
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/no files were uploaded/i);
    expect(screen.getByRole('status')).toHaveTextContent(/could not save.*keep this tab open/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
  });

  it('fails closed when dropped items cannot be inspected and clears drag highlighting on leave', async () => {
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true })} />);
    const shell = view.container.querySelector('.status-composer-shell');
    const transfer = { types: ['Files'], files: [new File(['a'], 'one.txt', { type: 'text/plain' })], items: [{ kind: 'file', webkitGetAsEntry: () => { throw new Error('unavailable'); } }] };
    fireEvent.dragOver(shell, { dataTransfer: transfer });
    expect(shell).toHaveClass('image-drag-over');
    fireEvent.dragLeave(shell, { relatedTarget: null });
    expect(shell).not.toHaveClass('image-drag-over');
    await act(async () => { fireEvent.drop(shell, { dataTransfer: transfer }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be inspected.*no files were attached/i);
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  it('does not continue an old upload batch after the active session changes', async () => {
    let finish;
    uploadAttachmentMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const firstAdd = vi.fn(), nextAdd = vi.fn();
    const props = buildProps({ sessionId: 'first-session', allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd: firstAdd });
    const view = render(<DesktopStatusBar {...props} />);
    const files = [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.txt', { type: 'text/plain' })];
    fireEvent.drop(view.container.querySelector('.status-composer-shell'), { dataTransfer: { types: ['Files'], files, items: [] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    view.rerender(<DesktopStatusBar {...props} sessionId="next-session" onComposerAttachmentAdd={nextAdd} />);
    await act(async () => finish('/fixture/one.txt'));
    expect(uploadAttachmentMock).toHaveBeenCalledOnce();
    expect(firstAdd).not.toHaveBeenCalled();
    expect(nextAdd).not.toHaveBeenCalled();
    view.rerender(<DesktopStatusBar {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/previous file selection.*check/i);
    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
  });

  it('does not add a completed upload to a replacement file selection', async () => {
    let selection = {};
    let finish;
    const onComposerAttachmentAdd = vi.fn();
    uploadAttachmentMock.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true, onComposerAttachmentAdd,
      getAttachmentSelectionToken: () => selection, isAttachmentSelectionTokenCurrent: value => value === selection })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    fireEvent.change(view.container.querySelector('.status-composer-image-input'), { target: { files: [new File(['fixture'], 'old.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    selection = {};
    await act(async () => finish('/fixture/old.txt'));
    expect(onComposerAttachmentAdd).not.toHaveBeenCalled();
    expect(screen.getByText(/previous attachment.*file selections changed/i)).toBeVisible();
  });

  it('does not start an upload from a picker opened before the file selection was replaced', async () => {
    let selection = {};
    uploadAttachmentMock.mockReset();
    const view = render(<DesktopStatusBar {...buildProps({ allowAnyFile: true, attachmentsEnabled: true,
      getAttachmentSelectionToken: () => selection, isAttachmentSelectionTokenCurrent: value => value === selection })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    selection = {};
    await act(async () => { fireEvent.change(view.container.querySelector('.status-composer-image-input'), { target: { files: [new File(['fixture'], 'old.txt', { type: 'text/plain' })] } }); });
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(screen.getByText(/previous attachment.*file selections changed/i)).toBeVisible();
  });

  it('keeps an adopted saved selection when an older upload finishes later', async () => {
    setUser({ id: 'attachment-pending-review-fixture' });
    const sessionId = 'ss-attachment-pending-review';
    let finish;
    uploadAttachmentMock.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    function Harness() {
      const [items, setItems, error, retry, , conflict, useSaved, , getToken, isCurrent] = useComposerFileAttachments(sessionId);
      const [message, setMessage] = useState('Keep this draft');
      return <>
        <button onClick={() => setItems([{ name: 'mine.txt', path: '/fixture/mine.txt' }])}>Choose mine</button>
        {error && <AttachmentDraftStatus error={error} conflict={conflict} currentItems={items} onRetry={retry} onUseSaved={useSaved} />}
        <DesktopStatusBar {...buildProps({ sessionId, allowAnyFile: true, attachmentsEnabled: true, composerValue: message, onComposerChange: setMessage,
          composerAttachments: items, onComposerAttachmentAdd: item => setItems(current => [...current, item]),
          getAttachmentSelectionToken: getToken, isAttachmentSelectionTokenCurrent: isCurrent })} />
      </>;
    }
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    fireEvent.change(view.container.querySelector('.status-composer-image-input'), { target: { files: [new File(['old'], 'old.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledOnce());
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(sessionId));
    const saved = JSON.stringify({ version: 1, sessionId, items: [{ name: 'saved.txt', path: '/fixture/saved.txt' }] });
    localStorage.setItem(key, saved);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: saved, storageArea: localStorage })));
    fireEvent.click(screen.getByRole('button', { name: 'Review saved files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use saved files' }));
    await act(async () => finish('/fixture/old.txt'));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Remove saved.txt' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove old.txt' })).not.toBeInTheDocument();
    expect(screen.getByText(/previous attachment.*file selections changed/i)).toBeVisible();
    expect(localStorage.getItem(key)).toBe(saved);
    act(() => clearTokens(true));
  });

  it('inserts a skill instruction instead of sending when a skill is chosen', () => {
    const onComposerChange = vi.fn();
    const onComposerSubmit = vi.fn();
    const skills = [{ id: 's1', name: 'Release Notes', provider: 'claude', path: '/skills/release-notes/SKILL.md' }];
    render(<DesktopStatusBar {...buildProps({ composerValue: '/release', onComposerChange, onComposerSubmit, skills,
      runtimeInfo: { providerId: 'claude', label: 'Opus' } })} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });
    expect([onComposerChange.mock.calls, onComposerSubmit.mock.calls]).toEqual([[['Use the "Release Notes" skill (instructions: /skills/release-notes/SKILL.md). ']], []]);
  });

  it('submits the selected slash suggestion when Enter is pressed', () => {
    const onComposerChange = vi.fn();
    const onComposerSubmit = vi.fn();
    render(<DesktopStatusBar {...buildProps({
      composerValue: '/',
      onComposerChange,
      onComposerSubmit,
      runtimeInfo: { providerId: 'claude', label: 'Opus 4.6 | Ctx 11%' }
    })} />);

    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '/modelChange AI model' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });

    expect(onComposerChange).not.toHaveBeenCalled();
    expect(onComposerSubmit).toHaveBeenCalledWith('/clear');
  });

  it('shows slash suggestions from the selected AI type before runtime metadata arrives', () => {
    render(<DesktopStatusBar {...buildProps({
      aiType: 'claude',
      composerValue: '/'
    })} />);

    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '/helpShow available commands' })).toBeInTheDocument();
  });

  it('shows slash suggestions for custom AI providers with their own command catalog', () => {
    render(<DesktopStatusBar {...buildProps({
      aiType: 'qwen-3',
      composerValue: '/',
      customAiProviders: [{
        id: 'qwen-3',
        label: 'Qwen 3',
        title: 'Qwen 3',
        initialCommand: 'qwen --fast',
        slashCommands: [
          { cmd: '/reset', desc: 'Reset session' },
          { cmd: '/model', desc: 'Pick model' }
        ]
      }]
    })} />);

    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '/resetReset session' })).toBeInTheDocument();
  });

  it('hides slash suggestions when the terminal is not inside a coding cli', () => {
    render(<DesktopStatusBar {...buildProps({ composerValue: '/' })} />);

    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
  });

  it('disables the send button when the composer is empty', () => {
    render(<DesktopStatusBar {...buildProps({ composerValue: '   ' })} />);

    expect(screen.getByRole('button', { name: 'Send to terminal' })).toBeDisabled();
  });

  it('uploads pasted images into the composer as file paths', async () => {
    const onComposerAttachmentAdd = vi.fn();
    const imageFile = new File(['image'], 'capture.png', { type: 'image/png' });
    getImageFileFromDataTransferMock.mockResolvedValue(imageFile);
    uploadScreenshotMock.mockResolvedValue('/tmp/paste-image.png');

    render(<DesktopStatusBar {...buildProps({ composerValue: 'Look at this', onComposerAttachmentAdd })} />);

    fireEvent.paste(screen.getByRole('textbox', { name: 'Command composer' }), {
      clipboardData: {
        getData: () => '',
        items: []
      }
    });

    await waitFor(() => {
      expect(onComposerAttachmentAdd).toHaveBeenCalledWith({
        name: 'capture.png',
        path: '/tmp/paste-image.png'
      });
    });
  });

  it('uploads dropped images into the composer as file paths', async () => {
    const onComposerAttachmentAdd = vi.fn();
    const imageFile = new File(['image'], 'dropped.png', { type: 'image/png' });
    getImageFileFromDataTransferMock.mockResolvedValue(imageFile);
    uploadScreenshotMock.mockResolvedValue('/tmp/dropped-image.png');

    const { container } = render(<DesktopStatusBar {...buildProps({ onComposerAttachmentAdd })} />);
    const composerShell = container.querySelector('.status-composer-shell');

    fireEvent.drop(composerShell, {
      dataTransfer: {
        types: ['Files'],
        files: [imageFile],
        items: []
      }
    });

    await waitFor(() => {
      expect(onComposerAttachmentAdd).toHaveBeenCalledWith({
        name: 'dropped.png',
        path: '/tmp/dropped-image.png'
      });
    });
  });

  it('shows image upload failures in the composer', async () => {
    const imageFile = new File(['image'], 'too-large.png', { type: 'image/png' });
    getImageFileFromDataTransferMock.mockResolvedValue(imageFile);
    uploadScreenshotMock.mockRejectedValue(new Error('Maximum screenshot size is 10MB'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<DesktopStatusBar {...buildProps()} />);

    fireEvent.paste(screen.getByRole('textbox', { name: 'Command composer' }), {
      clipboardData: {
        getData: () => '',
        items: []
      }
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Maximum screenshot size is 10MB');
    consoleErrorSpy.mockRestore();
  });

  it('renders runtime info and lets the user switch git branches', () => {
    const onSelectGitBranch = vi.fn();
    render(<DesktopStatusBar {...buildProps({
      runtimeInfo: { label: 'Opus 4.6 | Ctx 11%' },
      gitBranches: ['main', 'feature/ui'],
      currentGitBranch: 'main',
      onSelectGitBranch
    })} />);

    expect(screen.queryByText('Opus 4.6 | Ctx 11%')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Session context', exact: true }));
    expect(screen.getByRole('dialog', { name: 'Session context' })).toHaveTextContent('Opus 4.6 | Ctx 11%');
    fireEvent.change(screen.getByRole('combobox', { name: 'Select git branch' }), { target: { value: 'feature/ui' } });

    expect(onSelectGitBranch).toHaveBeenCalledWith('feature/ui');
  });

  it('keeps command summaries out of the composer and dismisses context without losing a draft', () => {
    const { container } = render(<DesktopStatusBar {...buildProps({ composerValue: 'Unsent draft', sessionSummary: 'Repeated command title', runtimeInfo: { label: 'Runtime detail' } })} />);
    const trigger = screen.getByRole('button', { name: 'Session context', exact: true });
    expect(trigger.closest('.status-bar-right')).not.toBeNull();
    expect(container.querySelector('.status-composer-footer-row')).toBeNull();
    expect(screen.queryByText('Repeated command title')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Session context' });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveTextContent('Runtime detail');
    expect(dialog).toHaveTextContent('C:\\Users\\conor\\project');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Unsent draft');
  });

  it('keeps branch switching disabled during a pending change and closes context on session switches', () => {
    const props = buildProps({ gitBranches: ['main', 'feature/ui'], currentGitBranch: 'main', onSelectGitBranch: vi.fn(), isSwitchingGitBranch: true });
    const view = render(<DesktopStatusBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session context', exact: true }));
    expect(screen.getByRole('combobox', { name: 'Select git branch' })).toBeDisabled();
    view.rerender(<DesktopStatusBar {...props} sessionId="another-session" cwd="/another/project" />);
    expect(screen.queryByRole('dialog', { name: 'Session context' })).not.toBeInTheDocument();
    expect(props.onSelectGitBranch).not.toHaveBeenCalled();
  });

  it('ignores dropped attachments when the composer is read only', async () => {
    const image=new File(['image'],'blocked.png',{type:'image/png'});
    getImageFileFromDataTransferMock.mockResolvedValue(image);
    render(<DesktopStatusBar {...buildProps({composerDisabled:true})} />);
    fireEvent.drop(screen.getByRole('textbox',{name:'Command composer'}).closest('form'),{dataTransfer:{types:['Files'],files:[image]}});
    await waitFor(()=>expect(getImageFileFromDataTransferMock).toHaveBeenCalled());
    expect(uploadScreenshotMock).not.toHaveBeenCalled();
  });

  it('explains unsupported V4 attachments and prevents button, paste and drop uploads', async () => {
    const image = new File(['fixture'], 'fixture.png', { type: 'image/png' });
    getImageFileFromDataTransferMock.mockResolvedValue(image);
    render(<DesktopStatusBar {...buildProps({ attachmentsEnabled: false })} />);
    expect(screen.getByRole('button', { name: 'Add image' })).toBeDisabled();
    expect(screen.getByText(/attachments.*not.*supported/i)).toBeInTheDocument();
    fireEvent.paste(screen.getByRole('textbox', { name: 'Command composer' }), { clipboardData: { items: [] } });
    fireEvent.drop(screen.getByRole('textbox', { name: 'Command composer' }).closest('form'), { dataTransfer: { types: ['Files'], files: [image] } });
    await waitFor(() => expect(getImageFileFromDataTransferMock).toHaveBeenCalled());
    expect(uploadScreenshotMock).not.toHaveBeenCalled();
  });

});
