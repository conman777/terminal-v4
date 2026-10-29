import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import AttachmentDraftStatus from './AttachmentDraftStatus';
import { useComposerFileAttachments } from '../hooks/useComposerFileAttachments';
import { clearTokens, setUser } from '../utils/auth';

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
    mobileDetectMock.mockReturnValue(false);
    toggleAutocorrectMock.mockClear();
    uploadScreenshotMock.mockReset();
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
