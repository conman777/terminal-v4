import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_ID = /^[0-9a-f]{64}$/;

export function PrivateOutputReview({ sessionId, approval, onReject, disabled = false }) {
  const environment = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const actionId = approval?.toolInput?.actionId;
  const approvalId = approval?.approvalId;
  const scope = useMemo(() => ({ sessionId, approvalId, actionId, environment }), [sessionId, approvalId, actionId, environment]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const requestRef = useRef(null);
  const mountedRef = useRef(false);
  const [state, setState] = useState({ scope, phase: 'idle' });
  const currentState = state.scope === scope && (!state.auth || isAuthScopeCurrent(state.auth)) && !environment.aborted ? state : { scope, phase: 'idle' };

  useEffect(() => {
    mountedRef.current = true;
    setState(previous => previous.scope === scope ? previous : { scope, phase: 'idle' });
    const auth = captureAuthScope();
    const retire = () => {
      if (!isAuthScopeCurrent(auth) || environment.aborted) {
        requestRef.current?.abort();
        requestRef.current = null;
        if (scopeRef.current === scope) setState({ scope, phase: 'unavailable' });
      }
    };
    const unsubscribe = subscribeAuth(retire);
    environment.addEventListener('abort', retire, { once: true });
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      unsubscribe();
      environment.removeEventListener('abort', retire);
    };
  }, [scope, environment]);

  const valid = Boolean(sessionId && approvalId && ACTION_ID.test(actionId || ''));
  const base = `/api/structured/sessions/${encodeURIComponent(sessionId || '')}/private-output`;
  const isCurrent = (auth, controller) => mountedRef.current && scopeRef.current === scope
    && !environment.aborted && !controller.signal.aborted && isAuthScopeCurrent(auth);

  async function review() {
    if (!valid || disabled || requestRef.current || environment.aborted) return;
    const auth = captureAuthScope();
    const controller = new AbortController(); requestRef.current = controller;
    setState({ scope, auth, phase: 'loading' });
    try {
      const response = await apiFetch(`${base}/preview`, { method: 'POST', body: { approvalId, actionId }, signal: AbortSignal.any([controller.signal, environment]), cache: 'no-store' });
      if (!response.ok) throw new Error('Preview unavailable');
      if (!isCurrent(auth, controller)) return;
      const value = await response.json();
      if (!isCurrent(auth, controller)) return;
      const output = value?.output;
      if (!UUID.test(value?.previewToken || '') || output?.actionId !== actionId
        || typeof output.stdout !== 'string' || typeof output.stderr !== 'string'
        || output.stdout.length > 65536 || output.stderr.length > 65536
        || typeof output.stdoutTruncated !== 'boolean' || typeof output.stderrTruncated !== 'boolean'
        || (output.window !== undefined && !['head', 'tail'].includes(output.window))) throw new Error('Invalid preview');
      setState({ scope, auth, phase: 'review', token: value.previewToken, output });
    } catch {
      if (isCurrent(auth, controller)) setState({ scope, auth, phase: 'error', error: 'The private output could not be loaded. Try again.' });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  async function share() {
    const reviewed = currentState;
    if (!valid || disabled || requestRef.current || !reviewed.token || !isAuthScopeCurrent(reviewed.auth)) return;
    const controller = new AbortController(); requestRef.current = controller;
    setState({ ...reviewed, phase: 'sharing', error: '' });
    let rejected = false;
    try {
      const response = await apiFetch(`${base}/approve`, { method: 'POST', body: { approvalId, actionId, previewToken: reviewed.token }, signal: AbortSignal.any([controller.signal, environment]), cache: 'no-store' });
      if (!response.ok) { rejected = [400, 401, 403].includes(response.status); throw new Error('Decision unavailable'); }
      const receipt = await response.json();
      if (!isCurrent(reviewed.auth, controller)) return;
      if (!['accepted', 'already_decided'].includes(receipt?.status) || receipt.approvalId !== approvalId || receipt.approved !== true) throw new Error('Unconfirmed receipt');
      setState({ scope, auth: reviewed.auth, phase: 'shared' });
    } catch {
      if (isCurrent(reviewed.auth, controller)) {
        const uncertain = reviewed.uncertain || !rejected;
        setState({ ...reviewed, phase: 'review', uncertain, error: uncertain ? 'The output may have been shared. Check the conversation before retrying this exact decision.' : 'The decision was not accepted. Review the current action and try again.' });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  const busy = ['loading', 'sharing'].includes(currentState.phase);
  return <div className="structured-approval-prompt private-output-review" role="group" aria-label="Private output review">
    <div className="structured-approval-title" role="status">Review background output</div>
    <p>Output may contain sensitive information. If you share it, it enters the agent’s conversation history.</p>
    {!valid && <p role="alert">This review is missing its action information. Reconnect and try again.</p>}
    {currentState.phase === 'unavailable' && <p role="status">Your session changed. Reopen the conversation to review this output.</p>}
    {currentState.phase === 'shared' && <p role="status">Shared. Waiting for the conversation to update.</p>}
    {currentState.error && <p role="alert">{currentState.error}</p>}
    {currentState.output && <div className="private-output-streams">
      {currentState.output.window === 'tail' && <p>Most recent output; earlier output may be omitted.</p>}
      <div><strong>Standard output</strong><pre tabIndex={0} data-conversation-scroll-region>{currentState.output.stdout || '(empty)'}</pre>{currentState.output.stdoutTruncated && <p>{currentState.output.window === 'tail' ? 'Earlier output was omitted.' : 'Output was truncated.'}</p>}</div>
      <div><strong>Standard error</strong><pre tabIndex={0} data-conversation-scroll-region>{currentState.output.stderr || '(empty)'}</pre>{currentState.output.stderrTruncated && <p>{currentState.output.window === 'tail' ? 'Earlier output was omitted.' : 'Output was truncated.'}</p>}</div>
    </div>}
    {busy && <p role="status">{currentState.phase === 'loading' ? 'Loading private output…' : 'Sharing output…'}</p>}
    {currentState.phase !== 'shared' && <div className="desktop-interactive-prompt-actions">
      {!currentState.output ? <button type="button" className="desktop-interactive-action primary" disabled={!valid || disabled || busy || currentState.phase === 'unavailable'} onClick={review}>Review output</button>
        : <button type="button" className="desktop-interactive-action primary" disabled={disabled || busy} onClick={share}>{currentState.uncertain ? 'Check decision' : 'Share output'}</button>}
      <button type="button" className="desktop-interactive-action secondary" disabled={disabled || busy || !onReject || currentState.uncertain} onClick={() => onReject?.(approval)}>Reject</button>
    </div>}
  </div>;
}
