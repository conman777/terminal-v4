import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useKeyboardShortcuts', () => {
  it.each(['dialog', 'body'])('does not close a conversation from %s while a native modal is open', focus => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const close = vi.fn();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    renderHook(() => useKeyboardShortcuts({ onCloseTerminal: close }));
    (focus === 'dialog' ? dialog : document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
  });

  it('does not close the background conversation if focus is lost while a sheet is open', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const close = vi.fn();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    renderHook(() => useKeyboardShortcuts({ onCloseTerminal: close }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
  });
  it.each(['workspace-browser', 'workspace-panel-tools', 'preview-panel', 'preview-panel-mobile', 'modal'])('does not close a conversation from a focused %s', surface => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const close = vi.fn();
    const target = document.createElement('div');
    if (surface === 'modal') { target.setAttribute('role', 'dialog'); target.setAttribute('aria-modal', 'true'); }
    else target.className = surface;
    document.body.append(target);
    renderHook(() => useKeyboardShortcuts({ onCloseTerminal: close }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
  });
  it.each(['MacIntel', 'Linux x86_64'])('handles workspace shortcuts before terminal input on %s', platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const onNewTerminal = vi.fn();
    const onFocusPane = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    renderHook(() => useKeyboardShortcuts({ onNewTerminal, onFocusPane, paneCount: 2 }));
    const terminalEvents = [];
    input.addEventListener('keydown', event => terminalEvents.push(event.defaultPrevented));
    const modifier = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };

    for (const key of ['t', '2']) input.dispatchEvent(new KeyboardEvent('keydown', { key, ...modifier, bubbles: true, cancelable: true }));

    expect({ created: onNewTerminal.mock.calls, focused: onFocusPane.mock.calls, terminalEvents }).toEqual({
      created: [[]], focused: [[1]], terminalEvents: [true, true]
    });
  });

  it('preserves regular editors, ordinary shell input and disabled workspace shortcuts', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const onNewTerminal = vi.fn();
    const editor = document.createElement('textarea');
    const terminal = document.createElement('textarea');
    terminal.className = 'xterm-helper-textarea';
    document.body.append(editor, terminal);
    const { rerender } = renderHook(({ enabled }) => useKeyboardShortcuts({ onNewTerminal, enabled }), { initialProps: { enabled: true } });
    const events = [
      [editor, { key: 't', metaKey: true }],
      [terminal, { key: 't' }],
      [terminal, { key: 'c', ctrlKey: true }]
    ].map(([element, init]) => {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    rerender({ enabled: false });
    terminal.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true }));
    expect({ calls: onNewTerminal.mock.calls, events }).toEqual({ calls: [], events: [false, false, false] });
  });
});
