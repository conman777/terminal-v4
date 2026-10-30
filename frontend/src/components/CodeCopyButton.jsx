import { useEffect, useState } from 'react';

export function CodeCopyButton({ text }) {
  const [state, setState] = useState('idle');
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState('copied'); } catch { setState('failed'); }
  };
  return <span className="cc-copy-action">
    <button type="button" className="copy-btn cc-copy-button" onClick={copy} aria-label="Copy code">{state === 'copied' ? 'Copied' : 'Copy'}</button>
    <span className={state === 'failed' ? 'cc-copy-error' : 'cc-copy-feedback'} role="status">
      {state === 'failed' ? 'Could not copy. Try again.' : state === 'copied' ? 'Copied to clipboard' : ''}
    </span>
  </span>;
}
