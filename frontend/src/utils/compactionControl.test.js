import { describe, expect, it } from 'vitest';
import { CONTEXT_MEASUREMENT_SCOPE, validateContextSnapshot, validateCompactReceipt, validateCompactionInstructions, formatContextBytes, formatReportedTokens, getCompactionOutcome } from './compactionControl';
import { CONTEXT_SESSION, COMPACT_UUID, compactBody, contextSnapshot, compactReceipt, commandEvents, historyReceipt } from '../test/compactionFixtures';

describe('original V4 compaction validation and truthful formatting', () => {
  it('accepts a matching current byte sample with an explicit image-reference measurement scope', () => {
    const value = contextSnapshot();
    expect(validateContextSnapshot(value, CONTEXT_SESSION)).toEqual(value);
    expect(CONTEXT_MEASUREMENT_SCOPE).toBe(value.measurementScope);
  });
  it.each([
    ['foreign session', { sessionId: 'ss-foreign' }], ['unsafe sequence', { asOfSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing measurement scope', { measurementScope: undefined }], ['unknown measurement scope', { measurementScope: 'provider_tokens' }],
    ['unsent draft included', { draftIncluded: true }], ['invalid revision', { conversationRevision: 'a'.repeat(63) }],
    ['current sample without revision', { conversationRevision: null }], ['busy pretending compactable', { sampleStatus: 'busy', canCompact: true }],
  ])('rejects %s without displaying a usable current sample', (_name, change) => {
    expect(() => validateContextSnapshot(contextSnapshot(change), CONTEXT_SESSION)).toThrow(/invalid|context|sample/i);
  });
  it('rejects unsafe, negative or target-mismatched usage numbers', () => {
    for (const change of [{ requestBytes: -1 }, { requestBytes: Number.MAX_SAFE_INTEGER + 1 }, { inputTokens: -1 }, { model: 'other' }]) {
      const value = contextSnapshot(); value.usage = { ...value.usage, ...change };
      if ('inputTokens' in change) value.usage.lastRequest = change;
      expect(() => validateContextSnapshot(value, CONTEXT_SESSION)).toThrow();
    }
  });
  it('allows explicit no-history and unavailable samples without inventing a revision or byte count', () => {
    for (const status of ['no_saved_history', 'unavailable']) {
      const sample = contextSnapshot({ sampleStatus: status, blockedReason: status, canCompact: false, usage: null, conversationRevision: null });
      expect(validateContextSnapshot(sample, CONTEXT_SESSION)).toEqual(sample);
    }
  });
  it('formats actual bytes separately from nullable provider-reported token counters', () => {
    expect(formatContextBytes(12345)).toBe('12,345 bytes');
    expect(formatReportedTokens(null)).toBe('Not reported');
    expect(formatReportedTokens(undefined)).toBe('Not reported');
    expect(formatReportedTokens(0)).toBe('0');
    expect(formatReportedTokens(Number.MAX_SAFE_INTEGER + 1)).toBe('Not reported');
  });
  it('counts Unicode code points and rejects controls except CR, LF and tab', () => {
    expect(validateCompactionInstructions('😀'.repeat(4000))).toBe('');
    expect(validateCompactionInstructions(' \t\n\r ')).toBe('');
    expect(validateCompactionInstructions('😀'.repeat(4001))).toMatch(/4,?000/);
    for (const control of ['\0', '\u0001', '\u007f', '\u0080', '\u0085', '\u009f']) expect(validateCompactionInstructions(control)).toMatch(/control|character/i);
  });
  it('accepts an exact compact receipt with omitted messageId without relaxing ordinary send validation', () => {
    expect(validateCompactReceipt(compactReceipt(), COMPACT_UUID)).toEqual(compactReceipt());
    expect(validateCompactReceipt(compactReceipt(COMPACT_UUID, { messageId: null }), COMPACT_UUID).requestId).toBe(COMPACT_UUID);
  });
  it.each([
    { requestId: '00000000-0000-4000-8000-000000000099' }, { turnId: '' }, { acceptedSeq: 0 },
    { acceptedSeq: Number.MAX_SAFE_INTEGER + 1 }, { status: 'invented' },
  ])('rejects a malformed compact receipt %j', change => {
    expect(() => validateCompactReceipt(compactReceipt(COMPACT_UUID, change), COMPACT_UUID)).toThrow();
  });
  it('correlates only the exact canonical command body and turn, keeping growing history metrics honest', () => {
    const result = historyReceipt();
    expect(getCompactionOutcome(commandEvents(), compactBody())).toMatchObject({ status: 'completed', turnId: 'turn-compact-fixture', receipt: result });
    expect(result.afterBytes).toBeGreaterThan(result.beforeBytes);
    expect(() => getCompactionOutcome(commandEvents(compactBody({ instructions: 'different body' })), compactBody())).toThrow(/identity|payload|command/i);
  });
  it('does not let a late cancelled turn overwrite a committed compaction result', () => {
    const events = [...commandEvents(), { type: 'turn_completed', seq: 13, turnId: 'turn-compact-fixture', status: 'cancelled' }];
    expect(getCompactionOutcome(events, compactBody()).status).toBe('completed');
  });
  it('does not infer a result from unrelated or uncorrelated control events', () => {
    expect(getCompactionOutcome(commandEvents().slice(1), compactBody())).toBeNull();
    expect(getCompactionOutcome(commandEvents(compactBody({ requestId: '00000000-0000-4000-8000-000000000099' })), compactBody())).toBeNull();
  });
});

it('allows a confirmed terminal command without result detail but does not fabricate native-history metrics', () => {
  const events = commandEvents().filter(event => event.type !== 'compaction');
  expect(getCompactionOutcome(events, compactBody())).toMatchObject({ status: 'completed', receipt: null, detailsUnavailable: true });
});
it('rejects hydrated binary being mislabeled as the saved-text-only context measurement', () => {
  expect(() => validateContextSnapshot(contextSnapshot({ hydratedBinaryIncluded: true }), CONTEXT_SESSION)).toThrow();
});
