import { useId } from 'react';
import { useCompactionControl } from '../hooks/useCompactionControl';
import { formatContextBytes, formatReportedTokens, validateCompactionInstructions } from '../utils/compactionControl';
import './ConversationContextPanel.css';

const barriers = {
  busy: 'The conversation is busy. Finish or explicitly Stop its current activity before compacting.',
  cleanup_required: 'Conversation cleanup is required before compaction can run.',
  queue_has_priority: 'The follow-up queue has priority. Review or pause it in Queue before compacting.',
  no_saved_history: 'There is no saved conversation context to compact yet.',
  nothing_compactable: 'There is no earlier complete turn or large complete tool result to compact yet.',
  unavailable: 'The current saved context measurement is unavailable.',
};
const titles = { completed: 'Compaction completed', failed: 'Compaction failed', cancelled: 'Compaction cancelled', interrupted: 'Compaction interrupted after restart' };
const tokenLabels = [['inputTokens', 'Input tokens'], ['outputTokens', 'Output tokens'], ['cachedInputTokens', 'Cached input tokens'], ['cacheCreationTokens', 'Cache creation tokens']];
function ReportedCounters({ value }) { return <dl className="conversation-context-metrics">{tokenLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{formatReportedTokens(value?.[key])}</dd></div>)}</dl>; }

export function ConversationContextPanel(props) {
  const control = useCompactionControl(props), id = useId();
  const { context, outcome, pending } = control, usage = context?.usage;
  const instructionError = validateCompactionInstructions(control.instructions);
  const stopVisible = Boolean(props.onStopConversation && (props.conversationBusy || pending || control.requiresCleanup));
  return <section className="conversation-context-panel" aria-label="Conversation context controls">
    <header className="conversation-context-heading"><div><h3>Conversation context</h3><p>Review saved context and explicitly request a summary for future turns.</p></div>
      {props.onClose && <button type="button" className="btn-secondary" onClick={props.onClose}>Close context</button>}</header>
    {control.error && <p role="alert" className="conversation-context-error">{control.error}</p>}
    {control.storeError && <button type="button" className="btn-secondary" disabled={control.isSubmitting} onClick={() => control.retrySave()}>Retry saving on this device</button>}
    {props.stopError && <p role="alert" className="conversation-context-error">{props.stopError}</p>}
    {control.stopFailure && control.stopFailure !== props.stopError && <p role="alert" className="conversation-context-error">{control.stopFailure}</p>}
    {control.loading && <p role="status">Reading local saved context…</p>}
    <button type="button" className="btn-secondary" disabled={control.loading || control.isSubmitting} onClick={() => void control.reload()}>Refresh context</button>
    {context && <>
      <dl className="conversation-context-metrics"><div><dt>Provider</dt><dd>{context.provider}</dd></div><div><dt>Model</dt><dd>{context.model}</dd></div><div><dt>Reasoning</dt><dd>{context.reasoning || 'Not selected'}</dd></div></dl>
      <h4>Saved text context</h4>
      <p className="conversation-context-byte-value">{formatContextBytes(usage?.requestBytes)}</p>
      <p>Counts saved text, metadata and stored image references or normal text-only image placeholders for the model. Hydrated image binary and the unsent draft are excluded.</p>
      <p className="conversation-context-muted">Local sample as of conversation event {context.asOfSeq}. {context.sampleStatus === 'current' ? 'This is a byte measurement, not a token occupancy estimate.' : 'A current usable context measurement is not available.'}</p>
      {control.sampleStale && <p role="status">The conversation changed after this sample. Refresh context before compacting.</p>}
      {context.warning && <p role="status">{context.warning}</p>}
      {usage?.warning && usage.warning !== context.warning && <p role="status">{usage.warning}</p>}
      {usage && <>
        <dl className="conversation-context-metrics"><div><dt>Local request byte guard</dt><dd>{formatContextBytes(usage.byteLimit)}</dd></div><div><dt>Automatic summary trigger</dt><dd>{formatContextBytes(usage.autoTriggerBytes)}</dd></div><div><dt>Safe request target</dt><dd>{formatContextBytes(usage.safeRequestBytes)}</dd></div></dl>
        <h4>Model metadata</h4><dl className="conversation-context-metrics"><div><dt>Model context window (tokens)</dt><dd>{formatReportedTokens(usage.knownContextWindow)}</dd></div><div><dt>Reserved output (tokens)</dt><dd>{formatReportedTokens(usage.reservedOutputTokens)}</dd></div></dl>
        <h4>Last provider-reported request</h4><ReportedCounters value={usage.lastRequest} />
        <p className="conversation-context-muted">Historical counters are shown only when their saved configuration matches. Missing values are not estimated.</p>
      </>}
      {context.blockedReason && <p role="status">{barriers[context.blockedReason]}</p>}
    </>}
    {props.readOnly && <p>This conversation is read-only. Compaction and Stop are unavailable here.</p>}
    {control.requiresCleanup && <p role="status">Conversation cleanup is required or has not been confirmed. Its durable compaction outcome is shown separately.</p>}
    {pending && <div className="conversation-context-command"><p role="status">{pending.receipt ? `Compaction command ${pending.receipt.status}. Waiting for its exact canonical outcome.` : 'Compaction outcome is awaiting confirmation. Its original identity is kept.'}</p>
      <code>{pending.body.requestId}</code><div className="conversation-context-actions">
        <button type="button" className="btn-secondary" disabled={control.isSubmitting} onClick={() => void control.reconcile()}>Check compaction outcome</button>
        <button type="button" className="btn-secondary" disabled={control.isSubmitting || props.readOnly || props.conversationBusy || control.requiresCleanup} onClick={() => void control.retry()}>Retry same compaction</button>
      </div><p>Retry checks the saved command first and keeps its original instructions and revision. New edits below belong to a later command.</p></div>}
    {outcome && <section aria-label="Compaction result" className="conversation-context-command"><h4>{titles[outcome.status] || 'Compaction outcome'}</h4>
      {outcome.receipt ? <><p>Native history arrays before and after compaction; these are different from the saved text context measurement above.</p><dl className="conversation-context-metrics"><div><dt>Before</dt><dd>{formatContextBytes(outcome.receipt.beforeBytes)}</dd></div><div><dt>After</dt><dd>{formatContextBytes(outcome.receipt.afterBytes)}</dd></div></dl>
        {outcome.receipt.auxiliaryUsage?.length > 0 && <details><summary>Auxiliary summary request reports</summary>{outcome.receipt.auxiliaryUsage.map((value, index) => <section key={index} aria-label={`Auxiliary request ${index + 1}`}><ReportedCounters value={value} /></section>)}</details>}</> : <p>Compaction result details are not available. No before or after byte counts are inferred.</p>}
      {pending && <p>This result belongs to the previous command. The newer command above is still awaiting confirmation.</p>}
      {outcome.message && <p>{outcome.message}</p>}<p>The visible conversation history and your drafts are preserved. A manual summary does not guarantee a smaller history.</p>
    </section>}
    <form aria-label="Compact conversation" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void control.submit(); }}>
      <label htmlFor={`${id}-instructions`}>Compaction instructions (optional)</label>
      <textarea id={`${id}-instructions`} rows={4} maxLength={8000} value={control.instructions} aria-describedby={`${id}-hint`} aria-invalid={Boolean(instructionError)} onChange={event => control.setInstructions(event.target.value)} />
      <p id={`${id}-hint`}>Up to 4,000 Unicode characters. Instructions are saved separately on this device; ordinary and queued drafts stay separate.</p>
      {instructionError && <p role="alert">{instructionError}</p>}
      <button type="submit" className="btn-primary" disabled={!control.canSubmit || Boolean(instructionError)}>Compact conversation</button>
    </form>
    {stopVisible && <section className="conversation-context-command"><p>Stop conversation stops current conversation activity and holds queued work. It does not target only this compaction request or roll back a committed summary.</p>
      <button type="button" className="btn-secondary" disabled={props.readOnly || control.isStopping || props.isStopping} onClick={() => void control.stopConversation()}>{control.isStopping || props.isStopping ? 'Stopping conversation…' : 'Stop conversation'}</button>
    </section>}
    <p className="conversation-context-muted">Closing this dialog only stops waiting in this view. It does not stop an accepted command.</p>
  </section>;
}
