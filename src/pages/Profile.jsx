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
      { icon: User,        label: 'Personal Information', sub: personalInfoName,                          color: 'text-primary',    path: null },
      { icon: Fingerprint, label: 'Authentication',       sub: 'Biometrics · Voice · PIN',         color: 'text-blue-400',   path: null },
      { icon: Lock,        label: 'Security Centre',      sub: 'View security overview',           color: 'text-primary',    path: '/security' },
      { icon: Signal,      label: 'Network Status',       sub: 'View network status',              color: 'text-violet-400', path: '/network' },
      { icon: Layers,      label: 'Platform Readiness',    sub: 'Architecture and rollout readiness', color: 'text-primary',  path: '/platform' },
    ]},
    { section: 'Account Services', items: [
      { icon: CreditCard,  label: 'Limits & Permissions', sub: 'Daily limit: KSh 150,000',         color: 'text-amber-400',       path: null },
      { icon: FileText,    label: 'Account Statement',    sub: 'Download · Share · Export',        color: 'text-blue-400',        path: '/history' },
      { icon: Bell,        label: 'Notification Settings', sub: 'SMS · Push · Email',              color: 'text-primary',         path: '/notifications' },
      { icon: Globe,       label: 'Language',             sub: 'English / Kiswahili',              color: 'text-violet-400',      path: null },
    ]},
    { section: 'Growth & Rewards', items: [
      { icon: Award,       label: 'Refer & Earn',          sub: 'Earn KSh 50 per referral',        color: 'text-amber-400',        path: '/referral' },
      { icon: Globe,       label: 'Language / Lugha',      sub: 'English · Kiswahili · Sheng',     color: 'text-violet-400',       path: null },
    ]},
    { section: 'Support', items: [
      { icon: HelpCircle,  label: 'Help & Support',        sub: 'Contact · FAQs · Disputes',       color: 'text-primary',         path: null },
      { icon: Activity,    label: 'Activity Log',           sub: 'Device sessions · Login history', color: 'text-muted-foreground', path: '/security' },
      { icon: FileText,    label: 'Audit & Reconciliation',  sub: 'Ledger · Hashes · Recon runs',   color: 'text-amber-400',        path: '/audit' },
      ...(canViewFraudDashboard(user) && import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? [{ icon: ShieldAlert, label: 'Fraud Ops Center', sub: 'Alerts · Settlements · Queue health', color: 'text-red-400', path: '/admin' }] : []),
    ]},
  ];

  return (
    <AppErrorBoundary>
    <div className="px-4 py-5">
      {/* Profile card */}
      <div className="premium-card rounded-[24px] p-5 mb-4 overflow-hidden relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
        <div className="flex items-center gap-4 mb-4 min-w-0">
          <div className="w-14 h-14 rounded-2xl gradient-green flex items-center justify-center shrink-0 shadow-lg shadow-primary/20">
            <span className="text-white font-bold text-lg font-grotesk">{avatarInitials}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-foreground font-grotesk truncate" title={displayName}>
              {displayName}
            </h2>
            <p
              className="text-[13px] text-muted-foreground truncate font-mono tracking-tight"
              data-testid="profile-phone"
              title={user?.phone || undefined}
            >
              {displayPhone}
            </p>
            {tierLabel ? (
              <div className="flex items-center gap-1.5 mt-1">
                <Award size={10} className="text-amber-400" />
                <span className="text-[11px] text-amber-400 font-semibold">{tierLabel} Member</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 pt-3.5 border-t border-border/70">
          <Stat label="Transactions" value="—" color="text-primary" />
          <Stat label="Saved (YTD)" value="—" color="text-blue-400" />
          <Stat label="Bonga Points" value={sessionPoints} color="text-amber-400" />
        </div>
      </div>

      {/* KYC / Verification strip */}
      <div className="flex items-center gap-3 surface-panel rounded-2xl px-4 py-3 mb-4">
        <div className="security-shield-pulse w-9 h-9 rounded-xl bg-primary/10 border border-primary/15 flex items-center justify-center shrink-0">
          <ShieldCheck size={16} className="text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-foreground">Identity Readiness</p>
          <p className="text-[11px] text-muted-foreground">KYC workflow · SIM verification</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/15">Security readiness</span>
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-white/75 text-muted-foreground border border-primary/10">Risk controls preview</span>
        </div>
      </div>

      {/* Biometric Security Section */}
      <div className="mb-4">
        <p className="section-title mb-2">Biometric Security</p>
        <RenderGuard name="Biometric Panel">
          <BiometricSecurityPanel />
        </RenderGuard>
      </div>

      {/* Menu sections */}
      <RenderGuard name="Profile Menu">
        {menuItems.map(section => (
          <div key={section.section} className="mb-4">
            <p className="section-title mb-2">{section.section}</p>
            <div className="premium-card rounded-2xl overflow-hidden">
              {section.items.map((item, i) => {
                const Icon = item.icon;
                return (
                  <motion.button key={item.label} 
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 1 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => item.path && navigate(item.path)}
                    className={`flex items-center gap-3 px-4 py-3.5 w-full text-left active:bg-primary/5 transition-all ${
                      i < section.items.length - 1 ? 'border-b border-border/60' : ''
                    }`}>
                    <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/10 flex items-center justify-center shrink-0">
                      <Icon size={14} className={item.color} />
                    </div>
                    <div className="flex-1">
                      <p className="text-[13px] font-medium text-foreground">{item.label}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{item.sub}</p>
                    </div>
                    <ChevronRight size={13} className="text-muted-foreground/60" />
                  </motion.button>
                );
              })}
            </div>
          </div>
        ))}
      </RenderGuard>

      <button
        onClick={() => logout()}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-destructive/10 border border-destructive/15 text-destructive text-[13px] font-bold"
      >
        <LogOut size={14} /> Sign Out
      </button>

      <div className="mt-4 mb-1 rounded-2xl border border-primary/10 bg-white/75 px-3 py-2.5 flex items-center justify-center gap-2 shadow-sm">
        <Languages size={11} className="text-primary/70 shrink-0" />
        <p className="text-center text-[10px] font-semibold leading-relaxed text-muted-foreground">
          Zuri Connect Africa · v2.1.0 · PCI-DSS aligned · KDPA · English · Kiswahili · Sheng
        </p>
      </div>
    </div>
    </AppErrorBoundary>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="flex min-h-[60px] flex-col items-center justify-center rounded-2xl bg-white/70 border border-border/60 px-1.5 py-2 text-center">
      <p className={`font-grotesk font-bold text-sm leading-tight ${color}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight truncate w-full">{label}</p>
    </div>
  );
}
