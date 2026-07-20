import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <div className="theme-toggle" aria-label="Tema visual">
    <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')} aria-label="Tema claro"><Sun size={16}/></button>
    <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')} aria-label="Tema oscuro"><Moon size={16}/></button>
    <button className={theme === 'system' ? 'active' : ''} onClick={() => setTheme('system')} aria-label="Tema del sistema"><Monitor size={16}/></button>
  </div>;
}
