export async function getSpellChecker() {
  return null;
}

export function shouldSkipAutocorrectWord(word) {
  if (!word || word.length < 2) return true;
  if (word.startsWith('/')) return true;
  if (/[0-9]/.test(word)) return true;
  if (/\./.test(word)) return true;
  if (word === word.toUpperCase()) return true;
  return false;
}

export function getAutocorrectSuggestion(spell, word) {
  if (!spell || shouldSkipAutocorrectWord(word)) return null;
  if (spell.correct(word)) return null;

  const suggestions = spell.suggest(word);
  if (!suggestions?.length) return null;
  const first = suggestions[0];
  if (!first || first === word) return null;

  return first;
}

export function getTerminalAutocorrectEdit(spell, word) {
  const corrected = getAutocorrectSuggestion(spell, word);
  if (!corrected) return null;

  const originalLength = Array.from(word).length;
  const correctedLength = Array.from(corrected).length;

  return {
    original: word,
    corrected,
    replacementInput: `${'\x7f'.repeat(originalLength)}${corrected} `,
    undoInput: `${'\x7f'.repeat(correctedLength + 1)}${word}`
  };
}

export function shouldResetTerminalAutocorrectState(data) {
  return typeof data === 'string' && data.length > 0;
}
