import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileStatusBar } from './MobileStatusBar';

const sendToSessionMock = vi.fn();

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    sendToSession: sendToSessionMock
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
    sendToSessionMock.mockReset();
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

  it('submits the selected slash suggestion when Enter is pressed', () => {
    render(<MobileStatusBar {...buildProps({ runtimeInfo: { providerId: 'codex', label: 'gpt-5.4 high Â· 100% left' } })} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), {
      target: { value: '/' }
    });

    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command composer' }), { key: 'Enter' });

    expect(sendToSessionMock).toHaveBeenCalledWith('session-1', '/model\r');
  });

  it('hides slash suggestions when no coding cli runtime is active', () => {
    render(<MobileStatusBar {...buildProps()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), {
      target: { value: '/' }
    });

    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
  });

  it('uses theme-aware composer styles instead of hardcoded dark surfaces', () => {
    const { container } = render(<MobileStatusBar {...buildProps()} />);

    const styles = Array.from(container.querySelectorAll('style')).map((node) => node.textContent || '').join('\n');

    expect(styles).toContain('color-mix(in srgb, var(--bg-surface) 94%, transparent)');
    expect(styles).toContain('color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated))');
    expect(styles).toContain('font-size: 16px;');
  });
});
