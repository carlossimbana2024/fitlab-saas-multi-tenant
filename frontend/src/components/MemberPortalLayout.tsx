import { Dumbbell, Flame, Home, LogOut, UserRound } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MemberChatWidget } from './MemberChatWidget';
import { ThemeToggle } from './ThemeToggle';

const links = [
  { to: '/portal', label: 'Inicio', icon: Home, end: true },
  { to: '/portal/classes', label: 'Clases', icon: Dumbbell },
  { to: '/portal/progress', label: 'Progreso', icon: Flame },
  { to: '/portal/profile', label: 'Perfil', icon: UserRound },
];

export function MemberPortalLayout() {
  const { session, logout } = useAuth();

  return <div className="member-portal">
    <header>
      <div className="brand"><img src="/fitlab-logo.png" alt="FitLab"/><span>FITLAB</span></div>
      <div className="portal-tools"><ThemeToggle/><button className="ghost" onClick={() => void logout()}><LogOut/>Salir</button></div>
    </header>
    <nav className="member-portal-nav" aria-label="Navegación del portal del miembro">
      <div className="member-portal-nav-inner">
        {links.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : undefined}>
          <Icon/><span>{label}</span>
        </NavLink>)}
      </div>
    </nav>
    <main>
      <div className="portal-account-context" aria-label="Cuenta activa">
        <span>{session?.gymUser?.profiles?.full_name ?? session?.user.email ?? 'Miembro'}</span>
        <small>Portal del miembro</small>
      </div>
      <Outlet/>
    </main>
    <MemberChatWidget/>
  </div>;
}
