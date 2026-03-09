import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopStatusBar } from './DesktopStatusBar';

const toggleAutocorrectMock = vi.fn();

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: true,
    toggleAutocorrect: toggleAutocorrectMock
  })
}));

vi.mock('./TerminalMicButton', () => ({
  TerminalMicButton: () => <span data-testid="terminal-mic-mock" />
}));

const uploadScreenshotMock = vi.fn();
const getImageFileFromDataTransferMock = vi.fn();

vi.mock('../utils/api', () => ({
  uploadScreenshot: (...args) => uploadScreenshotMock(...args)
}));

vi.mock('../utils/clipboardImage', () => ({
  getImageFileFromDataTransfer: (...args) => getImageFileFromDataTransferMock(...args)
}));

function buildProps(overrides = {}) {
  return {
    sessionId: 'session-1',
    sessionTitle: 'Terminal 1',
    cwd: 'C:\\Users\\conor\\project',
    gitBranch: 'main',
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
  beforeEach(() => {
    toggleAutocorrectMock.mockClear();
    uploadScreenshotMock.mockReset();
    getImageFileFromDataTransferMock.mockReset();
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

  it('calls autocorrect toggle when autocorrect button is pressed', () => {
    render(<DesktopStatusBar {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable autocorrect' }));
    expect(toggleAutocorrectMock).toHaveBeenCalledTimes(1);
  });

  it('shows a fallback AI label for unknown providers', () => {
    render(<DesktopStatusBar {...buildProps({ aiType: 'deepseek' })} />);
    expect(screen.getByRole('button', { name: 'Choose AI coder' })).toHaveAttribute('title', 'Assistant: Deepseek');
  });

  it('lets the user choose a different AI coder from the footer menu', () => {
    const onSelectAiType = vi.fn();
    render(<DesktopStatusBar {...buildProps({ aiType: 'claude', onSelectAiType })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose AI coder' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Codex' }));

    expect(onSelectAiType).toHaveBeenCalledWith('codex');
  });

  it('launches the selected AI from the footer', () => {
    const onLaunchAi = vi.fn();
    render(<DesktopStatusBar {...buildProps({ aiType: 'gemini', onLaunchAi })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch Gemini' }));

    expect(onLaunchAi).toHaveBeenCalledTimes(1);
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

  it('renders runtime info and lets the user switch git branches', () => {
    const onSelectGitBranch = vi.fn();
    render(<DesktopStatusBar {...buildProps({
      runtimeInfo: { label: 'Opus 4.6 · Ctx 11%' },
      gitBranches: ['main', 'feature/ui'],
      currentGitBranch: 'main',
      onSelectGitBranch
    })} />);

    expect(screen.getByText('Opus 4.6 · Ctx 11%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select git branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'feature/ui' }));

    expect(onSelectGitBranch).toHaveBeenCalledWith('feature/ui');
  });
});
