import { Activity, CalendarDays, CircleDollarSign, CreditCard, LayoutDashboard, LogOut, Menu, Settings, UserCog, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import { AdminPinDialog } from './AdminPinDialog';

export function AppLayout() {
  const [open, setOpen] = useState(false); const { session, logout } = useAuth();
  const isOwner = session?.gymUser?.role === 'owner';
  const canAccess = (...permissionKeys: string[]) => isOwner || permissionKeys.some((permissionKey) =>
    session?.gymUser?.staff_permissions?.some((permission) => permission.permission_key === permissionKey && permission.access_mode !== 'denied'),
  );
  return <div className="app-shell">
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><img src="/fitlab-logo.png" alt="FitLab"/><span>FITLAB</span></div>
      <nav>
        <NavLink to="/dashboard"><LayoutDashboard/>Dashboard</NavLink>
        {canAccess('members.view') && <NavLink to="/members"><Users/>Miembros</NavLink>}
        {canAccess('attendance.register', 'attendance.void') && <NavLink to="/attendances"><Activity/>Asistencias</NavLink>}
        {canAccess('payments.register', 'payments.void', 'finances.view', 'members.manage') && <NavLink to="/memberships"><CreditCard/>Membresías</NavLink>}
        {canAccess('calendar.manage') && <NavLink to="/calendar"><CalendarDays/>Horarios</NavLink>}
        {isOwner && <NavLink to="/staff"><UserCog/>Personal</NavLink>}
        {canAccess('settings.manage') && <NavLink to="/settings"><Settings/>Configuración</NavLink>}
        {isOwner && <NavLink to="/billing"><CircleDollarSign/>Plan FitLab</NavLink>}
      </nav>
      <button className="logout" onClick={() => void logout()}><LogOut/>Cerrar sesión</button>
    </aside>
    <main className="main"><header className="topbar"><button className="menu" onClick={() => setOpen(!open)}><Menu/></button><div><strong>{session?.gymUser?.profiles?.full_name ?? session?.user.email}</strong><span>{session?.gymUser?.role}</span></div><ThemeToggle/></header><Outlet/></main>
    {session?.gymUser?.role === 'staff' && <AdminPinDialog/>}
  </div>;
}
