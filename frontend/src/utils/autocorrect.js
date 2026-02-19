// Shared spell-checker utilities for text inputs and terminal local buffering.
let spellInstance = null;
let loadPromise = null;

export async function getSpellChecker() {
  if (spellInstance) return spellInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const [{ default: nspell }, affRes, dicRes] = await Promise.all([
      import('nspell'),
      fetch('/dictionary-en.aff'),
      fetch('/dictionary-en.dic'),
    ]);

    const decoder = new TextDecoder('utf-8');
    const [aff, dic] = await Promise.all([
      affRes.arrayBuffer().then((b) => decoder.decode(b)),
      dicRes.arrayBuffer().then((b) => decoder.decode(b)),
    ]);

    spellInstance = nspell({ aff, dic });
    return spellInstance;
  })();

  return loadPromise;
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
