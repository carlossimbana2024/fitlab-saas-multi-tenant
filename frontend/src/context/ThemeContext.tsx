import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: 'light', setTheme: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('fitlab-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    // Resolve the former automatic setting once, preserving the current appearance.
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('fitlab-theme', theme);
  }, [theme]);
  return <ThemeContext.Provider value={useMemo(() => ({ theme, setTheme }), [theme])}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
