import { describe, expect, it } from 'vitest';
import { buildStructuredSession } from './structuredSessions';
describe('owned V4 snapshot lifecycle mapping', () => {
  it('preserves current lifecycle status and a replay watermark from canonical snapshot events', () => {
    expect(buildStructuredSession({ id: 'ss-owned', runtime: 'v4', status: 'reconciliation_required', events: [{ seq: 3 }, { seq: 8 }, { seq: 5 }] })).toMatchObject({ runtime: 'v4', status: 'reconciliation_required', statusSeq: 8 });
    expect(buildStructuredSession({ id: 'ss-legacy', events: [] })).not.toHaveProperty('status');
  });
});

describe('Codex speed mapping', () => {
  it.each([['fast', 'fast'], ['native default', null]])('exposes a %s serviceTier from the snapshot', (_, serviceTier) => {
    expect(buildStructuredSession({ id: 'ss-codex', runtime: 'codex', model: 'gpt-5.5', serviceTier })).toMatchObject({ model: 'gpt-5.5', serviceTier });
  });
  it('leaves serviceTier unspecified for snapshots that predate it', () => {
    expect(buildStructuredSession({ id: 'ss-codex', runtime: 'codex', model: 'gpt-5.5' })).not.toHaveProperty('serviceTier');
  });
});
