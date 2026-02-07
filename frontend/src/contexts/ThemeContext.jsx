import { createContext, useContext, useState, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem('theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  const setTheme = useCallback((newTheme) => {
    setThemeState(newTheme);

    // Add transition class, apply theme, then remove transition class
    document.documentElement.setAttribute('data-theme-transitioning', '');
    document.documentElement.setAttribute('data-theme', newTheme);

    try {
      localStorage.setItem('theme', newTheme);
    } catch { /* ignore */ }

    // Persist to server
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme })
    }).catch(e => console.error('Failed to save theme to server', e));

    // Remove transition class after animation completes
    setTimeout(() => {
      document.documentElement.removeAttribute('data-theme-transitioning');
    }, 250);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
