import { useRef, useEffect, useCallback } from 'react';

// Module-level singleton — dictionary loads once, shared across all instances
let spellInstance = null;
let loadPromise = null;

async function getSpellChecker() {
  if (spellInstance) return spellInstance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [{ default: nspell }, { default: dict }] = await Promise.all([
      import('nspell'),
      import('dictionary-en')
    ]);
    spellInstance = nspell(dict);
    return spellInstance;
  })();
  return loadPromise;
}

function shouldSkip(word) {
  if (!word || word.length < 2) return true;
  if (word.startsWith('/')) return true;           // slash commands
  if (/[0-9]/.test(word)) return true;             // paths, versions
  if (/\./.test(word)) return true;                // URLs, file paths
  if (word === word.toUpperCase()) return true;    // ACRONYMS
  return false;
}

export function useAutocorrectInput(text, setText, enabled) {
  const spellRef = useRef(null);
  const correctionRef = useRef(null); // { original, corrected, atIndex }
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    getSpellChecker().then(spell => { spellRef.current = spell; });
  }, [enabled]);

  const handleKeyDown = useCallback((e) => {
    const spell = spellRef.current;

    // One backspace undoes the last correction
    if (e.key === 'Backspace' && correctionRef.current) {
      const { original, corrected, atIndex } = correctionRef.current;
      correctionRef.current = null;
      e.preventDefault();
      setText(prev => {
        const before = prev.slice(0, atIndex);
        const after = prev.slice(atIndex + corrected.length + 1); // +1 for the space we added
        return before + original + after;
      });
      return true; // handled — caller should return early
    }

    // Any key other than space clears pending undo
    if (e.key !== ' ') {
      correctionRef.current = null;
      return false;
    }

    // Space: attempt correction of last word
    if (!enabledRef.current || !spell) return false;

    const cursorPos = e.target.selectionStart;
    const before = text.slice(0, cursorPos);
    const wordMatch = before.match(/(\S+)$/);
    if (!wordMatch) return false;

    const word = wordMatch[1];
    const wordStart = cursorPos - word.length;

    if (shouldSkip(word) || spell.correct(word)) return false;

    const suggestions = spell.suggest(word);
    if (!suggestions?.length || suggestions[0] === word) return false;

    const corrected = suggestions[0];
    correctionRef.current = { original: word, corrected, atIndex: wordStart };

    setText(prev => prev.slice(0, wordStart) + corrected + ' ' + prev.slice(cursorPos));
    e.preventDefault(); // we inserted the space ourselves

    return true;
  }, [text, setText]);

  return { handleKeyDown };
}
