import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { sha256Bytes } from '../utils/sha256';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function operationId(auth, requestId, childOperationId) {
  if (!auth.userId || !auth.home) throw new Error('Review scope unavailable');
  const hash = await sha256Bytes(new TextEncoder().encode(JSON.stringify(['delegation-cleanup-review-v1', auth.home, auth.userId, requestId.toLowerCase(), childOperationId.toLowerCase()])));
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = Array.from(hash.slice(0, 16), value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseChildren(value, requestId) {
  if (value?.requestId !== requestId || !Array.isArray(value.children) || value.children.length > 1000) throw new Error('Cleanup request changed');
  for (const child of value.children) {
    if (!uuid.test(child?.childOperationId || '') || !['taskId', 'childSessionId', 'workspacePath', 'provider', 'model'].every(key => typeof child[key] === 'string' && child[key].length > 0 && child[key].length <= 4096)) throw new Error('Invalid child');
  }
  if (new Set(value.children.map(child => child.childOperationId.toLowerCase())).size !== value.children.length) throw new Error('Duplicate child');
  return value.children;
}

function matchesReceipt(receipt, requestId, id, child) {
  return receipt?.status === 'reviewed' && receipt.requestId === requestId && receipt.operationId === id
    && receipt.childOperationId === child.childOperationId && receipt.taskId === child.taskId && receipt.childSessionId === child.childSessionId;
}

export default function DelegationCleanupReview({ requestId, onReviewed }) {
  const [children, setChildren] = useState([]), [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState([]), [error, setError] = useState('');
  const active = useRef(null), locked = useRef(false), callback = useRef(onReviewed);
  callback.current = onReviewed;
  useEffect(() => {
    const auth = captureAuthScope(), controller = new AbortController();
    let mounted = true;
    const current = () => mounted && !controller.signal.aborted && isAuthScopeCurrent(auth);
    const task = { auth, signal: controller.signal, current };
    active.current = task; locked.current = false;
    setChildren([]); setSelected(null); setChecked(false); setBlocked([]); setBusy(false); setError('');
    const unsubscribe = subscribeAuth(() => { if (!isAuthScopeCurrent(auth)) { controller.abort(); if (mounted) { setChildren([]); setSelected(null); setError(''); } } });
    (async () => {
      try {
        const response = await apiFetch('/api/structured/owner-cleanup/delegation-children', { home: true, signal: task.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('List unavailable');
        const items = parseChildren(await response.json(), requestId);
        if (current()) setChildren(items);
      } catch { if (current()) setError('Delegated children could not be loaded. Check cleanup status before continuing.'); }
    })();
    return () => { mounted = false; controller.abort(); unsubscribe(); if (active.current === task) active.current = null; };
  }, [requestId]);

  async function perform(child, checkOnly) {
    const task = active.current;
    if (!task?.current() || locked.current || !uuid.test(requestId) || (!checkOnly && (!checked || blocked.includes(child.childOperationId) || selected !== child.childOperationId))) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const id = await operationId(task.auth, requestId, child.childOperationId);
      if (!task.current()) return;
      const url = '/api/structured/owner-cleanup/delegation-review';
      const response = checkOnly
        ? await apiFetch(`${url}/${id}`, { home: true, signal: task.signal, cache: 'no-store' })
        : await apiFetch(url, { home: true, method: 'POST', signal: task.signal, body: { requestId, operationId: id, childOperationId: child.childOperationId, acknowledged: true } });
      if (!task.current()) return;
      if (checkOnly && response.status === 404) {
        const list = await apiFetch('/api/structured/owner-cleanup/delegation-children', { home: true, signal: task.signal, cache: 'no-store' });
        if (!list.ok) throw new Error('List unavailable');
        const items = parseChildren(await list.json(), requestId);
        if (!task.current()) return;
        if (!items.some(item => ['childOperationId', 'taskId', 'childSessionId', 'workspacePath', 'provider', 'model'].every(key => item[key] === child[key]))) throw new Error('Child changed');
        setChildren(items); setBlocked(ids => ids.filter(value => value !== child.childOperationId));
        setError('No review receipt is available yet. A previous request may still arrive; retry uses the same review identity.');
        return;
      }
      const receipt = await response.json();
      if (!task.current()) return;
      if (!response.ok || !matchesReceipt(receipt, requestId, id, child)) throw new Error('Receipt unavailable');
      setChildren(items => items.filter(item => item.childOperationId !== child.childOperationId));
      setSelected(null); setChecked(false); setBlocked(ids => ids.filter(value => value !== child.childOperationId));
      callback.current?.();
    } catch { if (task.current()) { setBlocked(ids => [...new Set([...ids, child.childOperationId])]); setError('The delegated child review could not be confirmed. Check review status before retrying.'); } }
    finally { if (task.current()) { locked.current = false; setBusy(false); } }
  }

  return <div className="owner-cleanup-background-review">
    <p>Review each delegated child. Process identities are not saved: on the host, personally inspect and stop all processes associated with that child. The server cannot verify that they stopped. If you cannot verify this, leave cleanup pending.</p>
    {children.map(child => <div key={child.childOperationId}>
      <p>{child.provider} · {child.model}<br />{child.workspacePath}<br />Task: {child.taskId}<br />Child session: {child.childSessionId}</p>
      <label><input type="checkbox" disabled={busy} checked={selected === child.childOperationId && checked} onChange={event => { setSelected(child.childOperationId); setChecked(event.target.checked); setError(''); }} /> I personally checked and stopped all associated processes for this delegated child.</label>
      <button type="button" disabled={busy || selected !== child.childOperationId || !checked || blocked.includes(child.childOperationId)} onClick={() => perform(child, false)}>Confirm delegated child review</button>{' '}
      <button type="button" disabled={busy} onClick={() => perform(child, true)}>Check review status</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
