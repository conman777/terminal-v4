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
  });

  it('renders offline status when disconnected', () => {
    render(<DesktopStatusBar {...buildProps({ connectionState: 'offline' })} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
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

  it('calls autocorrect toggle when autocorrect button is pressed', () => {
    render(<DesktopStatusBar {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable autocorrect' }));
    expect(toggleAutocorrectMock).toHaveBeenCalledTimes(1);
  });

  it('shows a fallback AI label for unknown providers', () => {
    render(<DesktopStatusBar {...buildProps({ aiType: 'deepseek' })} />);
    expect(screen.getByText('Deepseek')).toBeInTheDocument();
  });
});
