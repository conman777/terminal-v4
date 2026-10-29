import './KeyboardShortcutsSetting.css';
import { useEffect, useState } from 'react';
import { bindingFromEvent, formatBinding, KEYBINDING_ACTIONS, loadBindings, resetBindings, saveBinding } from '../utils/keybindings';

export function KeyboardShortcutsSetting() {
  const [bindings, setBindings] = useState(loadBindings);
  const [recording, setRecording] = useState(null);
  useEffect(() => {
    if (!recording) return undefined;
    const record = event => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { setRecording(null); return; }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      saveBinding(recording, binding);
      setBindings(loadBindings());
      setRecording(null);
    };
    window.addEventListener('keydown', record, true);
    return () => window.removeEventListener('keydown', record, true);
  }, [recording]);
  return (
    <div className="form-group session-settings-field">
      <label>Keyboard Shortcuts</label>
      <table className="keyboard-shortcuts-table">
        <tbody>
          {KEYBINDING_ACTIONS.map(action => (
            <tr key={action.id}>
              <th scope="row">{action.label}</th>
              <td><kbd>{recording === action.id ? 'Press keys…' : formatBinding(bindings[action.id])}</kbd></td>
              <td><button type="button" className="btn-secondary" aria-label={`Change ${action.label} shortcut`} onClick={() => setRecording(action.id)}>Change</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn-secondary" onClick={() => { resetBindings(); setBindings(loadBindings()); setRecording(null); }}>Reset shortcuts</button>
      <small>Press Change, then the new key combination. Escape cancels. Cmd/Ctrl+1–8 still focuses panes.</small>
    </div>
  );
}
