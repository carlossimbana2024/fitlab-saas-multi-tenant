import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { MemberPortalLayout } from './components/MemberPortalLayout';
import { AdminRoute, MemberRoute, OwnerRoute, ProtectedRoute, RoleHome } from './components/ProtectedRoute';
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
import { StaffPage } from './pages/StaffPage';
import { ReceiptVerificationPage } from './pages/ReceiptVerificationPage';
import { OwnerControlPage } from './pages/OwnerControlPage';
import { InventoryPage } from './pages/InventoryPage';
import { ActivitiesPage } from './pages/ActivitiesPage';
import { CheckInPage } from './pages/CheckInPage';
import { MemberCommunityPage } from './pages/MemberCommunityPage';
import { PlatformBillingPage } from './pages/PlatformBillingPage';
import { LoyaltyPage } from './pages/LoyaltyPage';
import { MemberRewardsPage } from './components/LoyaltyRewards';

export default function App() {
  return <Routes>
    <Route path="/check-in" element={<CheckInPage/>}/>
    <Route path="/login" element={<LoginPage/>}/>
    <Route path="/accept-invite" element={<AcceptInvitePage/>}/>
    <Route path="/forgot-password" element={<ForgotPasswordPage/>}/>
    <Route path="/reset-password" element={<ResetPasswordPage/>}/>
    <Route path="/register-owner" element={<RegisterOwnerPage/>}/>
    <Route path="/owner/confirm" element={<OwnerOnboardingPage/>}/>
    <Route path="/legal/terms" element={<LegalPage/>}/>
    <Route path="/legal/privacy" element={<LegalPage/>}/>
    <Route path="/receipt/verify/:token" element={<ReceiptVerificationPage/>}/>
    <Route element={<ProtectedRoute/>}>
      <Route path="/platform/billing" element={<PlatformBillingPage/>}/>
      <Route path="/owner/setup" element={<OwnerOnboardingPage/>}/>
      <Route index element={<RoleHome/>}/>
      <Route element={<MemberRoute/>}>
        <Route element={<MemberPortalLayout/>}>
          <Route path="/portal" element={<MemberPortalPage section="home"/>}/>
          <Route path="/portal/classes" element={<MemberPortalPage section="classes"/>}/>
          <Route path="/portal/progress" element={<MemberPortalPage section="progress"/>}/>
          <Route path="/portal/community" element={<MemberCommunityPage/>}/>
          <Route path="/portal/profile" element={<MemberPortalPage section="profile"/>}/>
          <Route path="/portal/rewards" element={<MemberRewardsPage/>}/>
        </Route>
      </Route>
      <Route element={<AdminRoute/>}><Route element={<AppLayout/>}>
        <Route path="/dashboard" element={<DashboardPage/>}/>
        <Route path="/members" element={<MembersPage/>}/>
        <Route path="/attendances" element={<AttendancesPage/>}/>
        <Route path="/memberships" element={<MembershipsPage/>}/>
        <Route path="/calendar" element={<CalendarPage/>}/>
        <Route path="/activities" element={<ActivitiesPage/>}/>
        <Route path="/inventory" element={<InventoryPage/>}/>
        <Route element={<OwnerRoute/>}>
          <Route path="/loyalty" element={<LoyaltyPage/>}/>
          <Route path="/owner-control" element={<OwnerControlPage/>}/>
          <Route path="/staff" element={<StaffPage/>}/>
        </Route>
        <Route path="/settings" element={<SettingsPage/>}/>
        <Route path="/billing" element={<BillingPage/>}/>
        <Route path="/billing/success" element={<BillingResultPage/>}/>
        <Route path="/billing/cancel" element={<BillingResultPage/>}/>
      </Route></Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes>;
}
