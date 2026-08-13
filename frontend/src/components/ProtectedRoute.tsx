import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
export function ProtectedRoute() { const { session, loading } = useAuth(); if (loading) return <div className="splash">Cargando FitLab…</div>; return session ? <Outlet/> : <Navigate to="/login" replace/>; }
export function AdminRoute() { const { session } = useAuth(); if (session?.onboardingRequired || !session?.gymUser) return <Navigate to="/owner/setup" replace/>; return session.gymUser.role === 'member' ? <Navigate to="/portal" replace/> : <Outlet/>; }
export function OwnerRoute() { const { session } = useAuth(); return session?.gymUser?.role === 'owner' ? <Outlet/> : <Navigate to="/dashboard" replace/>; }
export function MemberRoute() { const { session } = useAuth(); if (session?.onboardingRequired || !session?.gymUser) return <Navigate to="/owner/setup" replace/>; return session.gymUser.role === 'member' ? <Outlet/> : <Navigate to="/dashboard" replace/>; }
export function RoleHome() { const { session } = useAuth(); if (session?.onboardingRequired || !session?.gymUser) return <Navigate to="/owner/setup" replace/>; return <Navigate to={session.gymUser.role === 'member' ? '/portal' : '/dashboard'} replace/>; }
