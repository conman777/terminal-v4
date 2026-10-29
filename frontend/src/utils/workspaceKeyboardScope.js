export function workspaceKeyboardBlocked(target) {
  return Boolean(target?.closest?.('[data-pane-resize-handle], .workspace-panel-resizer, .workspace-panel-tools, .workspace-browser, .preview-panel, .preview-panel-mobile, [role="menu"], [role="listbox"], .ph-session-menu, .ph-session-btn[aria-expanded="true"], .threads-session-edit, [role="dialog"][aria-modal="true"], dialog[open][aria-modal="true"]')
    || document.querySelector(':is([role="dialog"][aria-modal="true"], dialog[open][aria-modal="true"], .app-resources-surface):not([aria-hidden="true"]):not([hidden])'));
}
