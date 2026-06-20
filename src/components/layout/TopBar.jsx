import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, ChevronLeft, ShieldCheck } from 'lucide-react';
import { AI_BRAND } from '@/lib/branding/aiBrand';
import { isHesabuRoute } from '@/lib/hesabuRoutes';

const routeTitles = {
  '/': 'Hesabu',
  '/home': null,
  '/history': 'Transactions',
  '/chama': 'Hesabu',
  '/profile': 'Account',
  '/ai': AI_BRAND.routeTitle,
  '/notifications': 'Notifications',
  '/schedules': 'Standing Orders',
  '/wallet': 'M-PESA Wallet',
  '/security': 'Security Centre',
  '/network': 'Network Status',
  '/platform': 'Platform Readiness',
  '/audit': 'Audit & Reconciliation',
  '/admin': 'Fraud Ops Center',
};

export default function TopBar() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const title     = routeTitles[location.pathname];
  // The Zuri dashboard (branded logo + bell header) now lives at '/home'.
  const isHome    = location.pathname === '/home';
  // Chama (Hesabu) routes adopt the dark surface so the bar flows into the hero
  // instead of leaving a white→dark seam. Adding `hesabu-theme` here also brings
  // the --hesabu-* vars into scope (TopBar renders above the page's themed
  // subtree). Hesabu now lives at BOTH '/' and '/chama'; Zuri routes never take
  // this branch, so they're untouched.
  const isChama   = isHesabuRoute(location.pathname);

  const rootCls = isChama
    ? 'hesabu-theme bg-hesabu-ink border-b border-hesabu-line px-4 flex items-center justify-between h-[60px] shrink-0 z-20 relative'
    : 'bg-background/90 backdrop-blur-xl border-b border-primary/10 px-4 flex items-center justify-between h-[60px] shrink-0 z-20 relative';

  return (
    <div className={rootCls}>
      {isHome ? (
        <>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-2xl gradient-green flex items-center justify-center shadow-lg shadow-primary/20 shrink-0">
              <span className="text-white font-bold text-sm tracking-tight font-grotesk">Z</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1">
                <span className="font-grotesk font-bold text-[14px] text-foreground tracking-tight">Zuri Connect</span>
                <span className="text-primary text-[11px] font-bold">Africa</span>
              </div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.18em]">M-PESA intelligence</p>
            </div>
          </div>
          <button
            onClick={() => navigate('/notifications')}
            className="relative w-9 h-9 rounded-2xl soft-icon-button flex items-center justify-center transition-all hover:bg-primary/8"
          >
            <Bell size={15} className="text-muted-foreground" />
            <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary shadow-sm shadow-primary" />
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}
            className={`w-9 h-9 rounded-2xl soft-icon-button flex items-center justify-center transition-all ${isChama ? 'hover:bg-hesabu-surface-2' : 'hover:bg-primary/8'}`}
          >
            <ChevronLeft size={17} className={isChama ? 'text-hesabu-paper' : 'text-foreground'} />
          </button>
          <span className={`font-jakarta font-bold text-[13px] tracking-tight ${isChama ? 'text-hesabu-paper' : 'text-foreground'}`}>{title}</span>
          <div className={`w-9 h-9 rounded-2xl flex items-center justify-center border ${isChama ? 'bg-hesabu-surface border-hesabu-line' : 'bg-primary/8 border-primary/15'}`}>
            <ShieldCheck size={13} className={isChama ? 'text-hesabu-emerald' : 'text-primary'} />
          </div>
        </>
      )}
    </div>
  );
}
