import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileStatusBar } from './MobileStatusBar';

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    sendToSession: vi.fn()
  })
}));

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: true,
    toggleAutocorrect: vi.fn()
  })
}));

vi.mock('../hooks/useAutocorrectInput', () => ({
  useAutocorrectInput: () => ({
    handleKeyDown: () => false
  })
}));

vi.mock('./TerminalMicButton', () => ({
  TerminalMicButton: ({ provider }) => <div data-testid={`mic-${provider}`} />
}));

function buildProps(overrides = {}) {
  return {
    sessionId: 'session-1',
    onImageUpload: vi.fn(),
    onOpenHistory: vi.fn(),
    viewMode: 'terminal',
    onToggleViewMode: vi.fn(),
    isConnected: true,
    aiType: 'codex',
    customAiProviders: [],
    onSelectAiType: vi.fn(),
    onAddCustomAiCommand: vi.fn(),
    onLaunchAi: vi.fn(),
    ...overrides
  };
}

describe('MobileStatusBar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows AI selector controls and launches the current provider', () => {
    const onLaunchAi = vi.fn();
    render(<MobileStatusBar {...buildProps({ onLaunchAi })} />);

    expect(screen.getByRole('button', { name: /choose ai coder/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /launch codex/i }));
    expect(onLaunchAi).toHaveBeenCalledTimes(1);
  });

  it('selects a different AI provider from the mobile menu', () => {
    const onSelectAiType = vi.fn();
    render(<MobileStatusBar {...buildProps({ onSelectAiType })} />);

    fireEvent.click(screen.getByRole('button', { name: /choose ai coder/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /gemini/i }));

    expect(onSelectAiType).toHaveBeenCalledWith('gemini');
  });

  it('adds a custom AI command from the mobile menu', () => {
    const onAddCustomAiCommand = vi.fn();
    const promptSpy = vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('Qwen 3')
      .mockReturnValueOnce('qwen --fast');

    render(<MobileStatusBar {...buildProps({ onAddCustomAiCommand })} />);

    fireEvent.click(screen.getByRole('button', { name: /choose ai coder/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /add custom command/i }));

    expect(onAddCustomAiCommand).toHaveBeenCalledWith('Qwen 3', 'qwen --fast');
    promptSpy.mockRestore();
  });
});
