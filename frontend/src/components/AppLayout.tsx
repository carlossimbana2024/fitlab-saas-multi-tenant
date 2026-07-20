import { Activity, CalendarDays, CircleDollarSign, CreditCard, LayoutDashboard, LogOut, Menu, Settings, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';

export function AppLayout() {
  const [open, setOpen] = useState(false); const { session, logout } = useAuth();
  return <div className="app-shell">
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><img src="/fitlab-logo.png" alt="FitLab"/><span>FITLAB</span></div>
      <nav>
        <NavLink to="/dashboard"><LayoutDashboard/>Dashboard</NavLink>
        <NavLink to="/members"><Users/>Miembros</NavLink>
        <NavLink to="/attendances"><Activity/>Asistencias</NavLink>
        <NavLink to="/memberships"><CreditCard/>Membresías</NavLink>
        <NavLink to="/calendar"><CalendarDays/>Horarios</NavLink>
        {session?.gymUser?.role === 'owner' && <NavLink to="/settings"><Settings/>Configuración</NavLink>}
        {session?.gymUser?.role === 'owner' && <NavLink to="/billing"><CircleDollarSign/>Plan FitLab</NavLink>}
      </nav>
      <button className="logout" onClick={() => void logout()}><LogOut/>Cerrar sesión</button>
    </aside>
    <main className="main"><header className="topbar"><button className="menu" onClick={() => setOpen(!open)}><Menu/></button><div><strong>{session?.gymUser?.profiles?.full_name ?? session?.user.email}</strong><span>{session?.gymUser?.role}</span></div><ThemeToggle/></header><Outlet/></main>
  </div>;
}
