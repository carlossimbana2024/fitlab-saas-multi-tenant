import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <div className="theme-toggle" aria-label="Tema visual">
    <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')} aria-label="Tema claro" aria-pressed={theme === 'light'}><Sun size={16}/></button>
    <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')} aria-label="Tema oscuro" aria-pressed={theme === 'dark'}><Moon size={16}/></button>
  </div>;
}
