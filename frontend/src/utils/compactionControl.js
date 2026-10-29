export const CONTEXT_MEASUREMENT_SCOPE = 'saved_text_and_metadata';
export const COMPACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const COMPACT_REVISION = /^[0-9a-f]{64}$/;
export const COMPACT_STATUSES = new Set(['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'cleanup_required', 'reconciliation_required']);
export const COMPACT_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const safeCount = value => Number.isSafeInteger(value) && value >= 0;
export const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
export const textBound = (value, max = 4096) => typeof value === 'string' && value.length <= max;
export const encodedBytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const reportedFields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens'];
const validReported = value => object(value) && reportedFields.every(key => value[key] == null || safeCount(value[key]));
const failContext = () => { throw new Error('The host returned an invalid context sample. Refresh before compacting.'); };

export function validateCompactionInstructions(value) {
  if (typeof value !== 'string') return 'Compaction instructions must be text.';
  if ([...value].length > 4000) return 'Compaction instructions must be at most 4,000 characters.';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return 'Compaction instructions contain an unsupported control character.';
  return '';
}

export function validateContextSnapshot(value, sessionId) {
  const statuses = ['current', 'busy', 'no_saved_history', 'unavailable'];
  const reasons = [null, 'busy', 'cleanup_required', 'queue_has_priority', 'no_saved_history', 'nothing_compactable', 'unavailable'];
  if (!object(value) || value.schemaVersion !== 1 || value.sessionId !== sessionId || !safeCount(value.asOfSeq)
    || !textBound(value.measuredAt, 64) || !Number.isFinite(Date.parse(value.measuredAt))
    || !textBound(value.provider, 256) || !value.provider || !textBound(value.model, 512) || !value.model
    || (value.reasoning != null && !textBound(value.reasoning, 256)) || value.scope !== 'saved_conversation'
    || value.measurementScope !== CONTEXT_MEASUREMENT_SCOPE || value.draftIncluded !== false || value.hydratedBinaryIncluded !== false
    || !statuses.includes(value.sampleStatus) || typeof value.canCompact !== 'boolean' || !reasons.includes(value.blockedReason)
    || (value.warning != null && !textBound(value.warning)) || (value.conversationRevision != null && !COMPACT_REVISION.test(value.conversationRevision))) failContext();
  if (value.sampleStatus === 'current' && (!value.conversationRevision || !object(value.usage))) failContext();
  if (['no_saved_history', 'unavailable'].includes(value.sampleStatus) && (value.usage != null || value.conversationRevision != null)) failContext();
  if (value.canCompact && (value.sampleStatus !== 'current' || value.blockedReason != null || !value.conversationRevision)) failContext();
  if (value.usage != null) {
    const usage = value.usage;
    if (!object(usage) || usage.provider !== value.provider || usage.model !== value.model || usage.measurementScope !== CONTEXT_MEASUREMENT_SCOPE
      || !['requestBytes', 'byteLimit', 'autoTriggerBytes', 'safeRequestBytes'].every(key => safeCount(usage[key])) || usage.byteLimit < 1
      || usage.autoTriggerBytes > usage.byteLimit || usage.safeRequestBytes > usage.byteLimit
      || !['knownContextWindow', 'reservedOutputTokens'].every(key => usage[key] == null || safeCount(usage[key]))
      || (usage.lastRequest != null && !validReported(usage.lastRequest)) || (usage.warning != null && !textBound(usage.warning))) failContext();
  }
  if (encodedBytes(value) > 65536) failContext();
  return value;
}

export function validateCompactReceipt(value, requestId) {
  if (!object(value) || !COMPACT_UUID.test(requestId) || value.requestId !== requestId || !COMPACT_STATUSES.has(value.status)
    || !textBound(value.turnId, 256) || !value.turnId || !safeCount(value.acceptedSeq) || value.acceptedSeq < 1 || value.messageId != null) {
    throw new Error('The compaction receipt is invalid. Its command identity was kept.');
  }
  return value;
}

export function formatContextBytes(value) { return safeCount(value) ? `${value.toLocaleString('en-US')} bytes` : 'Not reported'; }
export function formatReportedTokens(value) { return safeCount(value) ? value.toLocaleString('en-US') : 'Not reported'; }

export function validCompactionBody(body) {
  return object(body) && Object.keys(body).sort().join(',') === 'expectedRevision,instructions,requestId'
    && COMPACT_UUID.test(body.requestId) && COMPACT_REVISION.test(body.expectedRevision)
    && (body.instructions === null || (typeof body.instructions === 'string' && !validateCompactionInstructions(body.instructions)));
}

export function validateHistoryReceipt(value, expectedRevision) {
  if (!object(value) || encodedBytes(value) > 64000 || !textBound(value.id, 256) || !value.id || !textBound(value.sessionId, 256)
    || value.sourceRevision !== expectedRevision || !['manual', 'automatic'].includes(value.trigger)
    || !textBound(value.provider, 256) || !textBound(value.model, 512) || !object(value.summary)
    || !['beforeBytes', 'afterBytes', 'retainedFrom'].every(key => safeCount(value[key]))
    || !textBound(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.auxiliaryUsage) || value.auxiliaryUsage.length > 16 || !value.auxiliaryUsage.every(validReported)) return null;
  return value;
}

// Requires the exact canonical command before correlating any turn or result.
// A committed compaction is stronger evidence than a later cancellation event.
export function getCompactionOutcome(events, body) {
  if (!validCompactionBody(body) || !Array.isArray(events) || events.length > 32768 || encodedBytes(events) > 16 * 1024 * 1024) throw new Error('Invalid compaction command evidence.');
  const commands = events.filter(event => object(event) && event.type === 'command_accepted' && event.requestId === body.requestId);
  if (!commands.length) return null;
  for (const command of commands) {
    if (command.command !== 'compact' || !object(command.input) || command.input.instructions !== body.instructions
      || command.input.expectedRevision !== body.expectedRevision || command.input.sourceRevision !== body.expectedRevision
      || !textBound(command.turnId, 256) || !command.turnId || !safeCount(command.seq) || command.seq < 1
      || command.turnId !== commands[0].turnId || command.seq !== commands[0].seq) throw new Error('Canonical compaction command payload or identity does not match the saved intent.');
  }
  const command = commands[0], turn = events.filter(event => object(event) && event.turnId === command.turnId && safeCount(event.seq) && event.seq > command.seq);
  const completed = turn.findLast(event => event.type === 'compaction' && event.status === 'completed');
  const terminal = turn.findLast(event => event.type === 'turn_completed' && COMPACT_TERMINAL.has(event.status));
  const failed = turn.findLast(event => event.type === 'compaction' && event.status === 'failed');
  const status = completed ? 'completed' : terminal?.status || (turn.some(event => event.type === 'turn_started') ? 'running' : 'accepted');
  const receipt = completed ? validateHistoryReceipt(completed.receipt, body.expectedRevision) : null;
  return { status, turnId: command.turnId, acceptedSeq: command.seq, receipt,
    detailsUnavailable: COMPACT_TERMINAL.has(status) && !receipt,
    message: textBound(failed?.message) ? failed.message : null };
}
