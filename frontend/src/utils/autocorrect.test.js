import { describe, expect, it } from 'vitest';
import { getTerminalAutocorrectEdit, shouldResetTerminalAutocorrectState } from './autocorrect';

describe('getTerminalAutocorrectEdit', () => {
  it('builds replacement and undo input for misspelled words', () => {
    const spell = {
      correct: (word) => word === 'the',
      suggest: () => ['the']
    };

    expect(getTerminalAutocorrectEdit(spell, 'teh')).toEqual({
      original: 'teh',
      corrected: 'the',
      replacementInput: '\x7f\x7f\x7fthe ',
      undoInput: '\x7f\x7f\x7f\x7fteh'
    });
  });

  it('skips slash commands and command-like words', () => {
    const spell = {
      correct: () => false,
      suggest: () => ['model']
    };

    expect(getTerminalAutocorrectEdit(spell, '/model')).toBeNull();
  });
});

describe('shouldResetTerminalAutocorrectState', () => {
  it('resets tracked words for pasted text and escape sequences', () => {
    expect(shouldResetTerminalAutocorrectState('git status')).toBe(true);
    expect(shouldResetTerminalAutocorrectState('\u001b[D')).toBe(true);
  });

  it('ignores empty terminal input payloads', () => {
    expect(shouldResetTerminalAutocorrectState('')).toBe(false);
  });
});
