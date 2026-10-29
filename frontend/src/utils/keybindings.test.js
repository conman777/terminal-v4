import { beforeEach, describe, expect, it } from 'vitest';
import { bindingFromEvent, eventMatches, formatBinding, loadBindings, resetBindings, saveBinding } from './keybindings';

const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });

beforeEach(() => localStorage.clear());

describe('keybindings', () => {
  it('matches the platform command key and exact modifiers', () => {
    expect([
      eventMatches(key('k', { metaKey: true }), 'mod+k', true),
      eventMatches(key('k', { ctrlKey: true }), 'mod+k', false),
      eventMatches(key('K', { metaKey: true, shiftKey: true }), 'mod+k', true),
      eventMatches(key('k', { metaKey: true, shiftKey: true }), 'mod+shift+k', true),
    ]).toEqual([true, true, false, true]);
  });

  it('records, saves and resets a custom binding', () => {
    const recorded = bindingFromEvent(key('j', { metaKey: true, altKey: true }), true);
    saveBinding('commandPalette', recorded);
    const custom = loadBindings().commandPalette;
    resetBindings();
    expect([recorded, custom, loadBindings().commandPalette, formatBinding('mod+shift+k', true), formatBinding('mod+k', false)])
      .toEqual(['mod+alt+j', 'mod+alt+j', 'mod+k', '⌘⇧K', 'Ctrl+K']);
  });

  it('ignores a key press that is only a modifier', () => {
    expect(bindingFromEvent(key('Shift', { shiftKey: true }), true)).toBeNull();
  });
});
