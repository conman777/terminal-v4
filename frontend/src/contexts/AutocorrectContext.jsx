import { createContext, useContext, useState, useCallback } from 'react';

const AutocorrectContext = createContext(null);
const STORAGE_KEY = 'autocorrectEnabled';

export function AutocorrectProvider({ children }) {
  const [autocorrectEnabled, setAutocorrectEnabled] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s === null ? true : s === 'true'; // default ON
    } catch { return true; }
  });

  const toggleAutocorrect = useCallback(() => {
    setAutocorrectEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  return (
    <AutocorrectContext.Provider value={{ autocorrectEnabled, toggleAutocorrect }}>
      {children}
    </AutocorrectContext.Provider>
  );
}

export function useAutocorrect() {
  const ctx = useContext(AutocorrectContext);
  if (!ctx) throw new Error('useAutocorrect must be used within AutocorrectProvider');
  return ctx;
}
