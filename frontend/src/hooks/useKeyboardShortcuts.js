import { useEffect, useCallback, useRef } from 'react';
import { workspaceKeyboardBlocked } from '../utils/workspaceKeyboardScope';
import { eventMatches, isMacPlatform, KEYBINDING_ACTIONS, loadBindings } from '../utils/keybindings';

const ACTION_HANDLERS = {
  commandPalette: 'onCommandPalette',
  findInThread: 'onFindInThread',
  toggleSidebar: 'onToggleSidebar',
  togglePreview: 'onTogglePreview',
  toggleFullScreen: 'onToggleFullScreen',
  newTerminal: 'onNewTerminal',
  closeTerminal: 'onCloseTerminal',
};

/**
 * Global keyboard shortcuts for desktop. Bindings come from Settings → Keyboard shortcuts
 * (see utils/keybindings.js); Cmd/Ctrl+1-8 focuses a pane and Escape leaves full screen.
 */
export function useKeyboardShortcuts({
  onCommandPalette,
  onFindInThread,
  onToggleSidebar,
  onTogglePreview,
  onToggleFullScreen,
  onFocusPane,
  onNewTerminal,
  onCloseTerminal,
  onExitFullScreen,
  isFullScreen,
  paneCount = 1,
  enabled = true
}) {
  const handlersRef = useRef({});
  handlersRef.current = { onCommandPalette, onFindInThread, onToggleSidebar, onTogglePreview, onToggleFullScreen, onFocusPane, onNewTerminal, onCloseTerminal, onExitFullScreen };

  const handleKeyDown = useCallback((e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const target = e.target;
    if (workspaceKeyboardBlocked(target)) return;
    const terminalInput = target.classList?.contains('xterm-helper-textarea');
    const typing = !terminalInput && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const mac = isMacPlatform();
    const cmdOrCtrl = mac ? e.metaKey : e.ctrlKey;

    if (e.key === 'Escape' && isFullScreen) {
      e.preventDefault();
      handlersRef.current.onExitFullScreen?.();
      return;
    }

    const bindings = loadBindings();
    for (const action of KEYBINDING_ACTIONS) {
      if ((typing && !action.inInputs) || !eventMatches(e, bindings[action.id], mac)) continue;
      const handler = handlersRef.current[ACTION_HANDLERS[action.id]];
      if (!handler) return;
      e.preventDefault();
      handler();
      return;
    }

    if (!typing && cmdOrCtrl && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
      const paneIndex = parseInt(e.key, 10) - 1;
      if (paneIndex < paneCount) {
        e.preventDefault();
        handlersRef.current.onFocusPane?.(paneIndex);
      }
    }
  }, [isFullScreen, paneCount]);

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handleKeyDown, enabled]);
}
