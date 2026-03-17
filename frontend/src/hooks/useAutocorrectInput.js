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

  const clearPendingCorrection = useCallback(() => {
    correctionRef.current = null;
  }, []);

  const handleKeyDown = useCallback((e) => {
    const spell = spellRef.current;

    // One backspace undoes the last correction
    if (e.key === 'Backspace' && correctionRef.current) {
      const { original, corrected, atIndex } = correctionRef.current;
      clearPendingCorrection();
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
      clearPendingCorrection();
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
  }, [clearPendingCorrection, text, setText]);

  const handleSelectionChange = useCallback((event) => {
    const correction = correctionRef.current;
    if (!correction) return;

    const selectionStart = event?.target?.selectionStart;
    const selectionEnd = event?.target?.selectionEnd;
    const expectedCursor = correction.atIndex + correction.corrected.length + 1;

    if (selectionStart !== expectedCursor || selectionEnd !== expectedCursor) {
      clearPendingCorrection();
    }
  }, [clearPendingCorrection]);

  return { handleKeyDown, handleSelectionChange, clearPendingCorrection };
}
