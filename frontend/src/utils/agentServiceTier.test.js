import { describe, expect, it } from 'vitest';
import { CODEX_SPEED_OPTIONS, serviceTierEntry } from './agentServiceTier';

describe('serviceTierEntry', () => {
  it.each([
    ['an explicit native default', null, { serviceTier: null }],
    ['Standard', 'default', { serviceTier: 'default' }],
    ['Fast', 'fast', { serviceTier: 'fast' }],
    ['Ultrafast', 'ultrafast', { serviceTier: 'ultrafast' }],
    ['an unspecified old selection', undefined, {}],
    ['an unknown tier', 'turbo', {}],
    ['a non-string value', 3, {}],
  ])('maps %s', (_, value, expected) => {
    expect(serviceTierEntry(value)).toEqual(expected);
  });
});

describe('CODEX_SPEED_OPTIONS', () => {
  it('offers native default first and never preselects a faster tier', () => {
    expect(CODEX_SPEED_OPTIONS).toEqual([
      { value: '', label: 'Default', description: 'Use local Codex settings' },
      { value: 'default', label: 'Standard', description: 'Standard usage' },
      { value: 'fast', label: 'Fast', description: 'Higher usage; availability depends on account' },
      { value: 'ultrafast', label: 'Ultrafast', description: 'Highest usage; eligible plans only' },
    ]);
  });
});
