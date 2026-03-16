import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileStatusBar } from './MobileStatusBar';

const sendToSessionMock = vi.fn();
const toggleAutocorrectMock = vi.fn();
let mockAutocorrectEnabled = true;

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    sendToSession: sendToSessionMock
  })
}));

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: mockAutocorrectEnabled,
    toggleAutocorrect: toggleAutocorrectMock
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
    ...overrides
  };
}

describe('MobileStatusBar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendToSessionMock.mockReset();
    toggleAutocorrectMock.mockReset();
    mockAutocorrectEnabled = true;
  });

  it('shows AI selector controls', () => {
    render(<MobileStatusBar {...buildProps()} />);

    expect(screen.getByRole('button', { name: /choose ai coder/i })).toBeInTheDocument();
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

  it('keeps the composer focused when selecting a slash suggestion', () => {
    render(<MobileStatusBar {...buildProps({ runtimeInfo: { providerId: 'codex', label: 'gpt-5.4 high Â· 100% left' } })} />);

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    composer.focus();
    fireEvent.change(composer, {
      target: { value: '/' }
    });

    fireEvent.pointerDown(screen.getByRole('option', { name: /\/model/i }));
    fireEvent.click(screen.getByRole('option', { name: /\/model/i }));

    expect(composer).toHaveFocus();
    expect(composer).toHaveValue('/model ');
  });

  it('uses the queued mobile send handler when provided', async () => {
    const onSendMessage = vi.fn().mockResolvedValue({ queued: true });
    render(<MobileStatusBar {...buildProps({ onSendMessage })} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Command composer' }), {
      target: { value: 'Explain this repo' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));

    expect(onSendMessage).toHaveBeenCalledWith('Explain this repo');
    expect(sendToSessionMock).not.toHaveBeenCalled();
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

  it('wires the autocorrect toggle into native text correction attributes', () => {
    const { rerender } = render(<MobileStatusBar {...buildProps()} />);

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    expect(composer).toHaveAttribute('autocorrect', 'on');
    expect(composer).toHaveAttribute('autocapitalize', 'sentences');
    expect(composer).toHaveAttribute('spellcheck', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Disable autocorrect' }));
    expect(toggleAutocorrectMock).toHaveBeenCalledTimes(1);

    mockAutocorrectEnabled = false;
    rerender(<MobileStatusBar {...buildProps()} />);

    expect(composer).toHaveAttribute('autocorrect', 'off');
    expect(composer).toHaveAttribute('autocapitalize', 'off');
    expect(composer).toHaveAttribute('spellcheck', 'false');
  });
});
