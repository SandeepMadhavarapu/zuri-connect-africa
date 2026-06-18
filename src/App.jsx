import React, { useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { redirectToLogin } from '@/services/authService.js';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { seedDemoData } from '@/lib/demoMode.js';
import ProtectedRoute from '@/components/ProtectedRoute';
import { getUserRole, ROLES } from '@/lib/rbac';
import { bootInfo } from '@/lib/devLog.js';

// Layout
import AppShell from './components/layout/AppShell';

// Pages
import Home from './pages/Home';
import History from './pages/History';
import ChamaHome from './pages/Chama';
import AI from './pages/AI';
import Profile from './pages/Profile';
import Notifications from './pages/Notifications';
import Schedules from './pages/Schedules';
import Wallet from './pages/Wallet';
import SecurityCentre from './pages/SecurityCentre';
import NetworkStatus from './pages/NetworkStatus';
import PlatformReadiness from './pages/PlatformReadiness';
import AuditDashboard from './pages/AuditDashboard';
import PhoneAuth from './pages/PhoneAuth';
import AdminSecurityDashboard from './pages/AdminSecurityDashboard';
import SecurityOperationsCenter from './pages/admin/SecurityOperationsCenter';
import ReconciliationCommandCenter from './pages/admin/ReconciliationCommandCenter';
import GlobalErrorBoundary from './components/system/GlobalErrorBoundary';
import DiagnosticsBadge from './components/system/DiagnosticsBadge';
import { logRouteAudit } from './lib/routeAudit';
import { validateAppState } from './lib/appValidation';

function BootLoadingScreen() {
  const statusLines = [
    'Securing session...',
    'Syncing wallet intelligence...',
    'Duke AI ready...',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-6">
      <div className="zuri-boot-backdrop" />
      <div className="relative w-full max-w-[280px] text-center">
        <div className="relative mx-auto mb-5 flex h-20 w-20 items-center justify-center">
          <div className="zuri-loader-pulse absolute inset-0 rounded-[28px] bg-primary/10" />
          <div className="absolute inset-2 rounded-[24px] border border-primary/15 bg-white/80 shadow-xl shadow-primary/10" />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl gradient-green shadow-lg shadow-primary/25">
            <span className="font-grotesk text-xl font-bold text-white">Z</span>
          </div>
        </div>
        <p className="font-grotesk text-base font-bold text-foreground">Zuri Connect Africa</p>
        <div className="startup-status-rotator mt-2">
          {statusLines.map((line) => (
            <p key={line} className="startup-status-line text-sm font-semibold text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-primary/10">
          <div className="startup-progress h-full rounded-full gradient-green" />
        </div>
      </div>
    </div>
  );
}

function UserNotRegisteredScreen({ message }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-4">
      <div className="glass-card rounded-2xl p-8 max-w-sm text-center border border-amber-400/20">
        <div className="w-12 h-12 rounded-2xl bg-amber-400/10 flex items-center justify-center mx-auto mb-4">
          <span className="text-xl">⚠️</span>
        </div>
        <p className="text-sm font-semibold text-foreground mb-2">Registration Required</p>
        <p className="text-xs text-muted-foreground mb-6">{message}</p>
        <button
          onClick={() => redirectToLogin()}
          className="w-full px-4 py-2.5 rounded-xl gradient-green text-black font-semibold text-sm"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function AdminRoute({ children }) {
  const { user } = useAuth();
  const role = getUserRole(user);
  if (role !== ROLES.ADMIN && role !== ROLES.AUDITOR && role !== ROLES.FRAUD_ANALYST) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function AuthenticatedApp() {
  const { authChecked, authError } = useAuth();

  useEffect(() => {
    if (!authChecked) return;
    bootInfo('[Zuri:Boot] AuthenticatedApp shell - authChecked=true, Router + AppShell hydrating (fail-open)');
    logRouteAudit();
    const validation = validateAppState();
    if (import.meta.env.DEV && validation.issues?.length) {
      console.table(validation.issues);
    }
  }, [authChecked]);

  useEffect(() => {
    if (!authChecked) return;
    seedDemoData().catch(() => {});
  }, [authChecked]);

  if (!authChecked) {
    return <BootLoadingScreen />;
  }

  if (authError?.type === 'user_not_registered') {
    return <UserNotRegisteredScreen message={authError.message} />;
  }

  const authRedirect = <Navigate to="/auth" replace />;

  return (
    <GlobalErrorBoundary>
      <Routes>
        {/* All financial routes require an authenticated Supabase session */}
        <Route element={<ProtectedRoute unauthenticatedElement={authRedirect} />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/chama" element={<ChamaHome />} />
            <Route path="/ai" element={<AI />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/wallet" element={<Wallet />} />
            <Route path="/security" element={<SecurityCentre />} />
            <Route path="/network" element={<NetworkStatus />} />
            <Route path="/platform" element={<PlatformReadiness />} />
            {/* Admin routes require elevated role on top of auth */}
            <Route path="/audit" element={<AdminRoute><AuditDashboard /></AdminRoute>} />
            {import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' && (
              <>
                <Route path="/admin" element={<AdminRoute><AdminSecurityDashboard /></AdminRoute>} />
                <Route path="/admin/soc" element={<AdminRoute><SecurityOperationsCenter /></AdminRoute>} />
              </>
            )}
            <Route path="/admin/reconciliation" element={<AdminRoute><ReconciliationCommandCenter /></AdminRoute>} />
          </Route>
        </Route>
        <Route path="/auth" element={<PhoneAuth />} />
        <Route path="*" element={<PageNotFound />} />
      </Routes>
      <DiagnosticsBadge />
    </GlobalErrorBoundary>
  );
}

function App() {
  useEffect(() => {
    bootInfo('[Zuri:Boot] App provider tree mounted');
  }, []);

  return (
    <QueryClientProvider client={queryClientInstance}>
      <AuthProvider>
        <Router>
          <AuthenticatedApp />
        </Router>
      </AuthProvider>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App
