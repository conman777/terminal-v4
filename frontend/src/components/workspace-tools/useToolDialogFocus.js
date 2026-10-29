import { useLayoutEffect, useRef } from 'react';

export function useToolDialogFocus(isOpen, onEscape) {
  const dialogRef = useRef(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const opener = document.activeElement;
    const controls = () => [...dialog.querySelectorAll('button, input, textarea, select, a[href], summary, [tabindex]')].filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
      for (let parent = element; parent && dialog.contains(parent); parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
    let lastFocused = controls()[0] || dialog;
    lastFocused.focus({ preventScroll: true });
    const contain = event => {
      if (dialog.contains(event.target)) { lastFocused = event.target; return; }
      if (event.target.closest('[role="dialog"], [role="alertdialog"]')) return;
      (controls().includes(lastFocused) ? lastFocused : controls()[0] || dialog).focus({ preventScroll: true });
    };
    const keyDown = event => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || event.target.closest('[role="dialog"]') !== dialog) return;
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault(); event.stopPropagation(); escapeRef.current(); return;
      }
      if (event.key !== 'Tab') return;
      const fields = controls(), first = fields[0], last = fields.at(-1);
      if (!first || document.activeElement === dialog || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', contain);
    dialog.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('focusin', contain);
      dialog.removeEventListener('keydown', keyDown);
      if (opener?.isConnected && (!document.activeElement?.closest('[role="dialog"]') || dialog.contains(document.activeElement))) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);
  return dialogRef;
}
