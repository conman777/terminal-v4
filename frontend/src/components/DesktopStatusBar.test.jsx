import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

function buildProps(overrides = {}) {
  return {
    sessionId: 'session-1',
    sessionTitle: 'Terminal 1',
    cwd: 'C:\\Users\\conor\\project',
    gitBranch: 'main',
    onImageUpload: vi.fn(),
    isTerminalPanelOpen: false,
    onToggleTerminalPanel: vi.fn(),
    connectionState: 'online',
    ...overrides
  };
}

describe('DesktopStatusBar', () => {
  beforeEach(() => {
    toggleAutocorrectMock.mockClear();
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
    expect(screen.getByText('deepseek')).toBeInTheDocument();
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
});
