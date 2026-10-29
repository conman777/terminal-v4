export const CONTEXT_SESSION = 'ss-00000000000000000000000000000031';
export const OTHER_CONTEXT_SESSION = 'ss-00000000000000000000000000000032';
export const COMPACT_UUID = '00000000-0000-4000-8000-000000000031';
export const CONTEXT_REVISION = 'a'.repeat(64);
export const COMPACT_TURN = 'turn-compact-fixture';
export const compactBody = (overrides = {}) => ({ requestId: COMPACT_UUID, instructions: 'Keep the test decisions.\n', expectedRevision: CONTEXT_REVISION, ...overrides });
export const contextSnapshot = (overrides = {}) => ({
  schemaVersion: 1, sessionId: CONTEXT_SESSION, asOfSeq: 8, measuredAt: '2026-10-17T00:00:00Z',
  provider: 'synthetic', model: 'synthetic-model', reasoning: 'high', conversationRevision: CONTEXT_REVISION,
  scope: 'saved_conversation', draftIncluded: false, hydratedBinaryIncluded: false, warning: null, measurementScope: 'saved_text_and_metadata',
  sampleStatus: 'current', canCompact: true, blockedReason: null,
  usage: { provider: 'synthetic', model: 'synthetic-model', measurementScope: 'saved_text_and_metadata',
    requestBytes: 12345, byteLimit: 600000, autoTriggerBytes: 420000, safeRequestBytes: 520000,
    knownContextWindow: null, reservedOutputTokens: null, lastRequest: null, warning: null }, ...overrides,
});
export const compactReceipt = (requestId = COMPACT_UUID, overrides = {}) => ({ status: 'accepted', requestId, turnId: COMPACT_TURN, acceptedSeq: 9, ...overrides });
export const historyReceipt = (overrides = {}) => ({ id: 'receipt-fixture', sessionId: 'engine-fixture', sourceRevision: CONTEXT_REVISION,
  previousReceipt: null, trigger: 'manual', provider: 'synthetic', model: 'synthetic-model', summary: { goals: ['Keep evidence.'] },
  beforeBytes: 30000, afterBytes: 31000, retainedFrom: 2, createdAt: '2026-10-17T00:00:01Z', auxiliaryUsage: [], ...overrides });
export const commandEvents = (body = compactBody(), result = historyReceipt()) => [
  { type: 'command_accepted', seq: 9, requestId: body.requestId, turnId: COMPACT_TURN, command: 'compact', input: { instructions: body.instructions, expectedRevision: body.expectedRevision, sourceRevision: CONTEXT_REVISION } },
  { type: 'turn_started', seq: 10, turnId: COMPACT_TURN },
  { type: 'compaction', seq: 11, turnId: COMPACT_TURN, status: 'completed', receipt: result, message: null },
  { type: 'turn_completed', seq: 12, turnId: COMPACT_TURN, status: 'completed' },
];
export const contextControlState = (events = [], overrides = {}) => ({ sessionId: CONTEXT_SESSION, generation: 1, latestSeq: events.at(-1)?.seq || 8, events, truncated: false, ...overrides });
export const compactResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
