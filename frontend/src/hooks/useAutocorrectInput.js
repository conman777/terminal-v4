import { useRef, useEffect, useCallback } from 'react';
import { getSpellChecker, getAutocorrectSuggestion } from '../utils/autocorrect';

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

    const corrected = getAutocorrectSuggestion(spell, word);
    if (!corrected) return false;
    correctionRef.current = { original: word, corrected, atIndex: wordStart };

    setText(prev => prev.slice(0, wordStart) + corrected + ' ' + prev.slice(cursorPos));
    e.preventDefault(); // we inserted the space ourselves

    return true;
  }, [text, setText]);

  return { handleKeyDown };
}
