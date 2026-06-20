import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import {
  User, ShieldCheck, Bell, Globe, ChevronRight,
  Fingerprint, Lock, FileText, HelpCircle, LogOut,
  Activity, CreditCard, Award, Signal, Languages, ShieldAlert, Layers
} from 'lucide-react';
import { canViewFraudDashboard } from '@/lib/rbac';
import { getRewardsState, getCurrentTier } from '@/lib/rewardsEngine';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import RenderGuard from '@/components/system/RenderGuard';
import BiometricSecurityPanel from '@/components/security/BiometricSecurityPanel';
import Eyebrow from '@/components/chama/ui/Eyebrow';
import {
  formatDisplayName,
  formatKenyanPhone,
  getAvatarInitials,
  DISPLAY_NAME_FALLBACK,
} from '@/lib/formatters/userDisplay';

export default function Profile() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [tierLabel, setTierLabel] = useState('');
  const [sessionPoints, setSessionPoints] = useState('—');

  useEffect(() => {
    try {
      const state = getRewardsState();
      const tier = getCurrentTier(state.lifetimePoints);
      setTierLabel(tier?.label || '');
      setSessionPoints(state.points != null ? String(state.points) : '—');
    } catch {
      // rewards engine unavailable — leave defaults
    }
  }, []);

  const displayName = formatDisplayName(user?.full_name || user?.email);
  const displayPhone = formatKenyanPhone(user?.phone);
  const avatarInitials = getAvatarInitials(user?.full_name || user?.email);
  const personalInfoName = displayName === DISPLAY_NAME_FALLBACK
    ? (user?.email || 'User')
    : displayName;

  const menuItems = [
    { section: 'Identity & Security', items: [
      { icon: User,        label: 'Personal Information', sub: personalInfoName,                          color: 'text-hesabu-emerald', path: null },
      { icon: Fingerprint, label: 'Authentication',       sub: 'Biometrics · Voice · PIN',         color: 'text-hesabu-emerald', path: null },
      { icon: Lock,        label: 'Security Centre',      sub: 'View security overview',           color: 'text-hesabu-emerald', path: '/security' },
      { icon: Signal,      label: 'Network Status',       sub: 'View network status',              color: 'text-hesabu-emerald', path: '/network' },
      { icon: Layers,      label: 'Platform Readiness',    sub: 'Architecture and rollout readiness', color: 'text-hesabu-emerald', path: '/platform' },
    ]},
    { section: 'Account Services', items: [
      { icon: CreditCard,  label: 'Limits & Permissions', sub: 'Daily limit: KSh 150,000',         color: 'text-hesabu-brass',   path: null },
      { icon: FileText,    label: 'Account Statement',    sub: 'Download · Share · Export',        color: 'text-hesabu-emerald', path: '/history' },
      { icon: Bell,        label: 'Notification Settings', sub: 'SMS · Push · Email',              color: 'text-hesabu-emerald', path: '/notifications' },
      { icon: Globe,       label: 'Language',             sub: 'English / Kiswahili',              color: 'text-hesabu-emerald', path: null },
    ]},
    { section: 'Growth & Rewards', items: [
      { icon: Award,       label: 'Refer & Earn',          sub: 'Earn KSh 50 per referral',        color: 'text-hesabu-brass',   path: '/referral' },
      { icon: Globe,       label: 'Language / Lugha',      sub: 'English · Kiswahili · Sheng',     color: 'text-hesabu-emerald', path: null },
    ]},
    { section: 'Support', items: [
      { icon: HelpCircle,  label: 'Help & Support',        sub: 'Contact · FAQs · Disputes',       color: 'text-hesabu-emerald', path: null },
      { icon: Activity,    label: 'Activity Log',           sub: 'Device sessions · Login history', color: 'text-hesabu-muted',   path: '/security' },
      { icon: FileText,    label: 'Audit & Reconciliation',  sub: 'Ledger · Hashes · Recon runs',   color: 'text-hesabu-brass',   path: '/audit' },
      ...(canViewFraudDashboard(user) && import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? [{ icon: ShieldAlert, label: 'Fraud Ops Center', sub: 'Alerts · Settlements · Queue health', color: 'text-hesabu-danger', path: '/admin' }] : []),
    ]},
  ];

  return (
    <AppErrorBoundary>
    <div className="hesabu-theme relative">
      {/* Ink fill anchored to the scroll container so the warm green-black surface
          spans the full visible height edge-to-edge regardless of content height —
          mirrors Home.jsx (the Wallet page). The route's
          .app-scrollbar[data-chama-route] fill handles the nav-clearance band. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-hesabu-ink"
      />

      <div className="relative px-4 py-5">
      {/* Profile card */}
      <div className="hesabu-card rounded-[24px] p-5 mb-4 overflow-hidden relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hesabu-emerald/35 to-transparent" />
        <div className="flex items-center gap-4 mb-4 min-w-0">
          <div className="w-14 h-14 rounded-2xl gradient-green flex items-center justify-center shrink-0 shadow-lg shadow-black/30">
            <span className="text-white font-bold text-lg font-grotesk">{avatarInitials}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-hesabu-paper font-grotesk truncate" title={displayName}>
              {displayName}
            </h2>
            <p
              className="text-[13px] text-hesabu-muted truncate font-mono tracking-tight"
              data-testid="profile-phone"
              title={user?.phone || undefined}
            >
              {displayPhone}
            </p>
            {tierLabel ? (
              <div className="flex items-center gap-1.5 mt-1">
                <Award size={10} className="text-hesabu-brass" />
                <span className="text-[11px] text-hesabu-brass font-semibold">{tierLabel} Member</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 pt-3.5 border-t border-hesabu-line">
          <Stat label="Transactions" value="—" color="text-hesabu-paper" />
          <Stat label="Saved (YTD)" value="—" color="text-hesabu-emerald" />
          <Stat label="Bonga Points" value={sessionPoints} color="text-hesabu-brass" />
        </div>
      </div>

      {/* KYC / Verification strip */}
      <div className="flex items-center gap-3 hesabu-card rounded-2xl px-4 py-3 mb-4">
        <div className="security-shield-pulse w-9 h-9 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0">
          <ShieldCheck size={16} className="text-hesabu-emerald" />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-hesabu-paper">Identity Readiness</p>
          <p className="text-[11px] text-hesabu-muted">KYC workflow · SIM verification</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-hesabu-surface-2 text-hesabu-emerald border border-hesabu-line">Security readiness</span>
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-hesabu-surface-2 text-hesabu-muted border border-hesabu-line">Risk controls preview</span>
        </div>
      </div>

      {/* Biometric Security Section */}
      <div className="mb-4">
        <Eyebrow tick className="mb-2">Biometric Security</Eyebrow>
        <RenderGuard name="Biometric Panel">
          <BiometricSecurityPanel />
        </RenderGuard>
      </div>

      {/* Menu sections */}
      <RenderGuard name="Profile Menu">
        {menuItems.map(section => (
          <div key={section.section} className="mb-4">
            <Eyebrow tick className="mb-2">{section.section}</Eyebrow>
            <div className="hesabu-card rounded-2xl overflow-hidden">
              {section.items.map((item, i) => {
                const Icon = item.icon;
                return (
                  <motion.button key={item.label}
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 1 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => item.path && navigate(item.path)}
                    className={`flex items-center gap-3 px-4 py-3.5 w-full text-left active:bg-hesabu-surface-2 transition-all ${
                      i < section.items.length - 1 ? 'border-b border-hesabu-line' : ''
                    }`}>
                    <div className="w-9 h-9 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0">
                      <Icon size={14} className={item.color} />
                    </div>
                    <div className="flex-1">
                      <p className="text-[13px] font-medium text-hesabu-paper">{item.label}</p>
                      <p className="text-[11px] text-hesabu-muted mt-0.5">{item.sub}</p>
                    </div>
                    <ChevronRight size={13} className="text-hesabu-muted" />
                  </motion.button>
                );
              })}
            </div>
          </div>
        ))}
      </RenderGuard>

      <button
        onClick={() => logout()}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-hesabu-danger/10 border border-hesabu-danger/20 text-hesabu-danger text-[13px] font-bold"
      >
        <LogOut size={14} /> Sign Out
      </button>

      <div className="mt-4 mb-1 rounded-2xl border border-hesabu-line bg-hesabu-surface px-3 py-2.5 flex items-center justify-center gap-2 shadow-sm">
        <Languages size={11} className="text-hesabu-brass shrink-0" />
        <p className="text-center text-[10px] font-semibold leading-relaxed text-hesabu-muted">
          Zuri Connect Africa · v2.1.0 · PCI-DSS aligned · KDPA · English · Kiswahili · Sheng
        </p>
      </div>
      </div>
    </div>
    </AppErrorBoundary>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="hesabu-elevated flex min-h-[60px] flex-col items-center justify-center rounded-2xl bg-hesabu-surface-2 border border-hesabu-line px-1.5 py-2 text-center">
      <p className={`font-mono tabular-nums font-bold text-sm leading-tight ${color}`}>{value}</p>
      <Eyebrow className="mt-1 leading-tight truncate w-full text-[9px] tracking-[0.1em] text-hesabu-muted">{label}</Eyebrow>
    </div>
  );
}
