import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { AdminRoute, MemberRoute, ProtectedRoute, RoleHome } from './components/ProtectedRoute';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { AttendancesPage } from './pages/AttendancesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { MemberPortalPage } from './pages/MemberPortalPage';
import { MembersPage } from './pages/MembersPage';
import { MembershipsPage } from './pages/MembershipsPage';
import { CalendarPage } from './pages/CalendarPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SettingsPage } from './pages/SettingsPage';
import { RegisterOwnerPage } from './pages/RegisterOwnerPage';
import { OwnerOnboardingPage } from './pages/OwnerOnboardingPage';
import { BillingPage } from './pages/BillingPage';
import { BillingResultPage } from './pages/BillingResultPage';
import { LegalPage } from './pages/LegalPage';
import { MemberChatWidget } from './components/MemberChatWidget';

export default function App() {
  return <Routes>
    <Route path="/login" element={<LoginPage/>}/>
    <Route path="/accept-invite" element={<AcceptInvitePage/>}/>
    <Route path="/forgot-password" element={<ForgotPasswordPage/>}/>
    <Route path="/reset-password" element={<ResetPasswordPage/>}/>
    <Route path="/register-owner" element={<RegisterOwnerPage/>}/>
    <Route path="/owner/confirm" element={<OwnerOnboardingPage/>}/>
    <Route path="/legal/terms" element={<LegalPage/>}/>
    <Route path="/legal/privacy" element={<LegalPage/>}/>
    <Route element={<ProtectedRoute/>}>
      <Route path="/owner/setup" element={<OwnerOnboardingPage/>}/>
      <Route index element={<RoleHome/>}/>
      <Route element={<MemberRoute/>}><Route path="/portal" element={<><MemberPortalPage/><MemberChatWidget/></>}/></Route>
      <Route element={<AdminRoute/>}><Route element={<AppLayout/>}>
        <Route path="/dashboard" element={<DashboardPage/>}/>
        <Route path="/members" element={<MembersPage/>}/>
        <Route path="/attendances" element={<AttendancesPage/>}/>
        <Route path="/memberships" element={<MembershipsPage/>}/>
        <Route path="/calendar" element={<CalendarPage/>}/>
        <Route path="/settings" element={<SettingsPage/>}/>
        <Route path="/billing" element={<BillingPage/>}/>
        <Route path="/billing/success" element={<BillingResultPage/>}/>
        <Route path="/billing/cancel" element={<BillingResultPage/>}/>
      </Route></Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes>;
}
