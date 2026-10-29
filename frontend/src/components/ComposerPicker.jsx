import { useEffect, useRef, useState } from 'react';
import './ComposerPicker.css';

export function ComposerPicker({ label, menuTitle = label, value, options, onChange, placeholder = 'Choose', icon, disabled = false, action, className = '', displayPrefix = '' }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const selected = options.find(option => option.value === value);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const selectedItem = root.current?.querySelector('[aria-checked="true"]') || root.current?.querySelector('[role="menuitemradio"], [role="menuitem"]');
    selectedItem?.focus();
    const close = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || disabled) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const items = [...root.current.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className={`composer-picker ${className}`} ref={root} onKeyDown={handleKeyDown}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button className="composer-picker-trigger" type="button" ref={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open}
      title={selected?.description || selected?.label || placeholder} disabled={disabled}
      onClick={() => { if (!options.length && action) action.onClick(); else setOpen(current => !current); }}>
      {icon}<span>{displayPrefix && <span className="composer-picker-prefix">{displayPrefix}</span>}{selected?.label || placeholder}</span>
      <svg className="composer-picker-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && !disabled && <div className="composer-picker-menu" role="menu" aria-label={label}>
      <div className="composer-picker-heading">{menuTitle}</div>
      {options.map(option => <button type="button" role="menuitemradio" aria-checked={option.value === value} key={option.value}
        onClick={() => { close(); onChange?.(option.value); }}>
        <span className="composer-picker-option-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <span aria-hidden="true">✓</span>}
      </button>)}
      {action && <button className="composer-picker-action" type="button" role="menuitem" aria-label={action.label} onClick={() => { close(); action.onClick(); }}><span aria-hidden="true">+</span>{action.text || action.label}</button>}
    </div>}
  </div>;
}
